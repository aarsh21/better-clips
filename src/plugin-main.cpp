/*
Better Clips for OBS
Keeps a replay buffer, saves clips locally and uploads them to YouTube.


This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>
*/

#include "replay.hpp"
#include "plugin-support.h"
#include "youtube-credential.hpp"

#include <obs-frontend-api.h>
#include <util/config-file.h>
#include <util/platform.h>

#include <curl/curl.h>

#include <QApplication>
#include <QClipboard>
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>
#include <QMainWindow>
#include <QMessageBox>
#include <QUuid>
#include <QMetaObject>
#include <QStatusBar>

#include <cstring>
#include <mutex>

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE(PLUGIN_NAME, "en-US")

namespace {

std::mutex config_mutex;
YouTubeSettings youtube;
std::string credential_id;
bool session_only = false, storage_notice_shown = false;
obs_hotkey_id save_hotkey = OBS_INVALID_HOTKEY_ID;
obs_output_t *replay_output = nullptr; /* our in-memory replay buffer */
bool ui_alive = true;
bool initialized = false;
bool dock_placed = false; /* the dock was put next to Controls once */
QString startup_notice;

std::string config_path()
{
	char *path = obs_module_config_path("config.json");
	std::string result = path ? path : "";
	bfree(path);
	return result;
}

void show_storage_notice()
{
	if (!session_only || storage_notice_shown)
		return;
	storage_notice_shown = true;
	auto *box = new QMessageBox(
		QMessageBox::Information, "Better Clips",
		"Secure storage is unavailable. You can upload this session, but you’ll need to sign in again after restarting OBS.",
		QMessageBox::Ok, static_cast<QWidget *>(obs_frontend_get_main_window()));
	box->setAttribute(Qt::WA_DeleteOnClose);
	box->open();
}

void replace_credential(const std::string &token)
{
	// A distinct id per grant keeps an inaccessible old keyring entry from
	// becoming the active credential after a session-only replacement.
	const auto old = credential_id;
	credential_id.clear();
	session_only = false;
	if (!token.empty()) {
		auto id = QUuid::createUuid().toString(QUuid::WithoutBraces).toStdString();
		if (youtube_credential::store(id, token))
			credential_id = id;
		else
			session_only = true;
	}
	if (!old.empty())
		youtube_credential::remove(old);
}

// During migration, backup rotation would copy the plaintext back into .bak.
bool write_migrated_config(const QString &path, const QJsonObject &obj)
{
	const auto bytes = QJsonDocument(obj).toJson();
	QSaveFile out(path);
	return out.open(QIODevice::WriteOnly) && out.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner) &&
	       out.write(bytes) == bytes.size() && out.commit();
}

bool migrate_config()
{
	const QString target = QString::fromStdString(config_path());
	const QDir dir = QFileInfo(target).dir();
	bool found = false, selected = false;
	QJsonObject active;
	for (const auto &path : {target, target + ".bak"}) {
		QFile source(path);
		if (!source.exists())
			continue;
		found = true;
		if (!source.open(QIODevice::ReadOnly)) {
			if (selected && path == target + ".bak")
				return false;
			continue;
		}
		const auto bytes = source.readAll();
		source.close();
		const auto doc = QJsonDocument::fromJson(bytes);
		if (!doc.isObject()) {
			if (selected && bytes.contains("youtube_refresh_token") && !write_migrated_config(path, active))
				return false;
			continue;
		}
		auto obj = doc.object();
		const auto old = obj.take("youtube_refresh_token");
		if (!selected) {
			credential_id = obj.value("youtube_credential_id").toString().toStdString();
			youtube.refresh_token = old.toString().toStdString();
			if (!youtube.refresh_token.empty())
				replace_credential(youtube.refresh_token);
			else if (!credential_id.empty())
				youtube.refresh_token = youtube_credential::read(credential_id);
		}
		if (!old.isUndefined()) {
			if (old.toString().toStdString() == youtube.refresh_token && !credential_id.empty())
				obj.insert("youtube_credential_id", QString::fromStdString(credential_id));
			if (!write_migrated_config(path, obj))
				return false;
		}
		if (!selected) {
			if (path != target && (!dir.mkpath(".") || !write_migrated_config(target, obj)))
				return false;
			active = obj;
			selected = true;
		}
	}
	return selected || !found;
}

void load_config()
{
	obs_data_t *data = obs_data_create_from_json_file_safe(config_path().c_str(), "bak");
	if (!data)
		return;
	obs_data_set_default_bool(data, "start_replay_buffer", true);
	youtube.start_replay_buffer = obs_data_get_bool(data, "start_replay_buffer");
	dock_placed = obs_data_get_bool(data, "dock_placed");
	youtube.route = static_cast<YouTubeRoute>(obs_data_get_int(data, "youtube_route"));
	youtube.app_url = obs_data_get_string(data, "youtube_app_url");
	youtube.upload_token = obs_data_get_string(data, "youtube_upload_token");
	youtube.channel_id = obs_data_get_string(data, "youtube_channel_id");
	youtube.channel_title = obs_data_get_string(data, "youtube_channel_title");
	youtube.previously_paired = !youtube.upload_token.empty() ||
				    obs_data_get_bool(data, "youtube_previously_paired");
	youtube.previously_direct = !youtube.refresh_token.empty() ||
				    obs_data_get_bool(data, "youtube_previously_direct");
	obs_data_set_default_string(data, "youtube_privacy", "unlisted");
	obs_data_set_default_string(data, "youtube_title", "{game} - {date} {time}");
	obs_data_set_default_int(data, "youtube_audio_track", 1);
	youtube.privacy = obs_data_get_string(data, "youtube_privacy");
	youtube.made_for_kids = obs_data_get_bool(data, "youtube_made_for_kids");
	youtube.title_template = obs_data_get_string(data, "youtube_title");
	youtube.description = obs_data_get_string(data, "youtube_description");
	youtube.review_before_upload = obs_data_get_bool(data, "youtube_review");
	youtube.audio_track = static_cast<int>(obs_data_get_int(data, "youtube_audio_track"));

	obs_data_array_t *hotkey = obs_data_get_array(data, "save_hotkey");
	obs_hotkey_load(save_hotkey, hotkey);
	obs_data_array_release(hotkey);
	obs_data_release(data);
}

/* config_mutex serializes the file transaction and the settings it publishes. */
bool write_config(const YouTubeSettings &account)
{
	obs_data_t *data = obs_data_create();
	{
		const auto &youtube = account;
		obs_data_set_bool(data, "start_replay_buffer", youtube.start_replay_buffer);
		obs_data_set_int(data, "youtube_route", static_cast<int>(youtube.route));
		obs_data_set_string(data, "youtube_credential_id", credential_id.c_str());
		obs_data_set_string(data, "youtube_app_url", youtube.app_url.c_str());
		obs_data_set_string(data, "youtube_upload_token", youtube.upload_token.c_str());
		obs_data_set_string(data, "youtube_channel_id", youtube.channel_id.c_str());
		obs_data_set_string(data, "youtube_channel_title", youtube.channel_title.c_str());
		obs_data_set_bool(data, "youtube_previously_paired", youtube.previously_paired);
		obs_data_set_bool(data, "youtube_previously_direct", youtube.previously_direct);
		obs_data_set_string(data, "youtube_privacy", youtube.privacy.c_str());
		obs_data_set_bool(data, "youtube_made_for_kids", youtube.made_for_kids);
		obs_data_set_string(data, "youtube_title", youtube.title_template.c_str());
		obs_data_set_string(data, "youtube_description", youtube.description.c_str());
		obs_data_set_bool(data, "youtube_review", youtube.review_before_upload);
		obs_data_set_int(data, "youtube_audio_track", youtube.audio_track);
	}
	obs_data_set_bool(data, "dock_placed", dock_placed);
	obs_data_array_t *hotkey = obs_hotkey_save(save_hotkey);
	obs_data_set_array(data, "save_hotkey", hotkey);
	obs_data_array_release(hotkey);

	char *dir = obs_module_config_path("");
	os_mkdirs(dir);
	bfree(dir);
	bool saved = obs_data_save_json_safe(data, config_path().c_str(), "tmp", "bak");
	if (!saved)
		obs_log(LOG_WARNING, "Could not save %s", config_path().c_str());
	obs_data_release(data);
	return saved;
}

void save_config()
{
	std::lock_guard<std::mutex> lock(config_mutex);
	write_config(youtube);
}

/* Starts our replay buffer on the encoders of OBS's replay buffer. OBS's
 * replay buffer also only keeps packets in memory until its own Save Replay
 * hotkey is pressed, which is the only thing that writes a file. */
void start_replay_output()
{
	obs_output_t *obs_replay = obs_frontend_get_replay_buffer_output();
	if (!obs_replay)
		return;

	obs_output_release(replay_output);
	replay_output = obs_output_create("better_clips_output", "Better Clips", nullptr, nullptr);

	obs_data_t *obs_settings = obs_output_get_settings(obs_replay);
	int max_time_sec = (int)obs_data_get_int(obs_settings, "max_time_sec");
	int max_size_mb = (int)obs_data_get_int(obs_settings, "max_size_mb");
	obs_data_t *settings = obs_data_create();
	obs_data_set_int(settings, "max_time_sec", max_time_sec);
	obs_data_set_int(settings, "max_size_mb", max_size_mb);
	obs_output_update(replay_output, settings);
	obs_data_release(settings);
	obs_data_release(obs_settings);

	obs_output_set_video_encoder(replay_output, obs_output_get_video_encoder(obs_replay));
	for (size_t i = 0; i < MAX_OUTPUT_AUDIO_ENCODERS; i++) {
		obs_encoder_t *encoder = obs_output_get_audio_encoder(obs_replay, i);
		if (encoder)
			obs_output_set_audio_encoder(replay_output, encoder, i);
	}
	obs_output_release(obs_replay);

	if (obs_output_start(replay_output))
		obs_log(LOG_INFO, "In-memory replay buffer started (%d s, %d MB)", max_time_sec, max_size_mb);
	else
		obs_log(LOG_ERROR, "Could not start in-memory replay buffer: %s",
			obs_output_get_last_error(replay_output));
}

/* OBS keeps the Replay Buffer settings in the profile, per output mode. */
const char *replay_section(config_t *profile)
{
	const char *mode = config_get_string(profile, "Output", "Mode");
	return mode && strcmp(mode, "Advanced") == 0 ? "AdvOut" : "SimpleOutput";
}

/* Turns on OBS's Replay Buffer in the current profile. OBS creates its
 * outputs after it loads plugins, so this takes effect on this start. */
void enable_replay_buffer_in_profile()
{
	config_t *profile = obs_frontend_get_profile_config();
	if (!profile)
		return;
	config_set_bool(profile, "SimpleOutput", "RecRB", true);
	config_set_bool(profile, "AdvOut", "RecRB", true);
	config_save_safe(profile, "tmp", nullptr);
}

/* Binds Ctrl+Alt+R to the save hotkey, unless it already has a key. */
void bind_default_hotkey()
{
	obs_data_array_t *current = obs_hotkey_save(save_hotkey);
	size_t bound = obs_data_array_count(current);
	obs_data_array_release(current);
	if (bound)
		return;

	obs_data_t *key = obs_data_create();
	obs_data_set_string(key, "key", "OBS_KEY_R");
	obs_data_set_bool(key, "control", true);
	obs_data_set_bool(key, "alt", true);
	obs_data_array_t *keys = obs_data_array_create();
	obs_data_array_push_back(keys, key);
	obs_hotkey_load(save_hotkey, keys);
	obs_data_array_release(keys);
	obs_data_release(key);
}

/* Starts OBS's Replay Buffer, which starts ours, unless that is turned off. */
void start_obs_replay_buffer()
{
	if (!get_youtube_settings().start_replay_buffer || obs_frontend_replay_buffer_active())
		return;
	obs_output_t *output = obs_frontend_get_replay_buffer_output();
	if (!output) {
		notify_user("Better Clips: turn on the Replay Buffer in Settings > Output");
		return;
	}
	obs_output_release(output);
	obs_frontend_replay_buffer_start();
}

void stop_replay_output()
{
	if (!replay_output)
		return;
	obs_output_force_stop(replay_output);
	obs_output_release(replay_output);
	replay_output = nullptr;
	obs_log(LOG_INFO, "In-memory replay buffer stopped");
}

void on_save_hotkey(void *, obs_hotkey_id, obs_hotkey_t *, bool pressed)
{
	if (pressed)
		QMetaObject::invokeMethod(
			qApp,
			[] {
				if (ui_alive)
					save_replay();
			},
			Qt::AutoConnection);
}

void on_frontend_event(enum obs_frontend_event event, void *)
{
	if (!initialized) {
		if (event == OBS_FRONTEND_EVENT_FINISHED_LOADING)
			place_save_dock();
		return;
	}
	switch (event) {
	case OBS_FRONTEND_EVENT_FINISHED_LOADING:
		show_storage_notice();
		/* Until OBS has saved a layout with the dock in it, put it next
		 * to Controls. After that, OBS remembers where the user keeps it. */
		if (!dock_placed)
			place_save_dock();
		check_youtube_pairing();
		start_obs_replay_buffer();
		break;
	case OBS_FRONTEND_EVENT_REPLAY_BUFFER_STARTED:
		start_replay_output();
		update_save_dock();
		break;
	case OBS_FRONTEND_EVENT_REPLAY_BUFFER_STOPPING:
	case OBS_FRONTEND_EVENT_REPLAY_BUFFER_STOPPED:
		stop_replay_output();
		update_save_dock();
		break;
	case OBS_FRONTEND_EVENT_PROFILE_CHANGED:
		update_save_dock();
		break;
	case OBS_FRONTEND_EVENT_EXIT:
		stop_youtube_reviews();
		stop_youtube_disconnect();
		stop_replay_output();
		dock_placed = true; /* OBS saves its layout, with the dock, as it exits */
		save_config();
		ui_alive = false;
		break;
	default:
		break;
	}
}

/* Runs whenever OBS saves its scene collection, so a hotkey binding changed
 * in Settings > Hotkeys is kept even if OBS doesn't exit cleanly. */
void on_frontend_save(obs_data_t *, bool saving, void *)
{
	if (saving)
		save_config();
}

} // namespace

bool replay_running()
{
	return replay_output && obs_output_active(replay_output);
}

QString plugin_startup_notice()
{
	return startup_notice;
}

bool plugin_disabled()
{
	return !initialized;
}

QString destination_setup_action()
{
	auto yt = get_youtube_settings();
	if (yt.route == YouTubeRoute::Direct ? !youtube_direct_available() || yt.refresh_token.empty()
					     : yt.app_url.empty() || yt.upload_token.empty())
		return "Connect YouTube";
	return {};
}

void retry_plugin_buffer()
{
	if (obs_frontend_replay_buffer_active() && !replay_running())
		start_replay_output();
	if (!replay_running())
		notify_user("Better Clips buffer could not start. Check the OBS log for the encoder error.");
}

void save_replay()
{
	if (!replay_running()) {
		notify_user(obs_frontend_replay_buffer_active()
				    ? "Better Clips buffer is stopped. Retry it in the Better Clips dock."
				    : "Better Clips: start the Replay Buffer first");
		return;
	}
	const auto action = destination_setup_action();
	if (!action.isEmpty()) {
		notify_user(action.toStdString() + " in Tools > Better Clips Settings");
		return;
	}
	replay_request_save(replay_output);
}

int get_replay_seconds()
{
	config_t *profile = obs_frontend_get_profile_config();
	return profile ? (int)config_get_int(profile, replay_section(profile), "RecRBTime") : 0;
}

void set_replay_seconds(int seconds)
{
	config_t *profile = obs_frontend_get_profile_config();
	if (!profile || seconds <= 0)
		return;
	if (seconds != get_replay_seconds()) {
		/* OBS's own Replay Buffer picks this up when it next starts. */
		config_set_int(profile, replay_section(profile), "RecRBTime", seconds);
		config_save_safe(profile, "tmp", nullptr);
	}
	sync_replay_seconds();
}

/* OBS only applies a new Maximum Replay Time when its Replay Buffer restarts.
 * Ours takes it right away: a longer length keeps more from now on. */
void sync_replay_seconds()
{
	int seconds = get_replay_seconds();
	if (!replay_output || seconds <= 0)
		return;
	obs_data_t *current = obs_output_get_settings(replay_output);
	bool changed = obs_data_get_int(current, "max_time_sec") != seconds;
	obs_data_release(current);
	if (!changed)
		return;

	obs_data_t *settings = obs_data_create();
	obs_data_set_int(settings, "max_time_sec", seconds);
	obs_output_update(replay_output, settings);
	obs_data_release(settings);
	obs_log(LOG_INFO, "Replay length set to %d s", seconds);
}

YouTubeSettings get_youtube_settings()
{
	std::lock_guard<std::mutex> lock(config_mutex);
	return youtube;
}

void set_youtube_settings(const YouTubeSettings &settings)
{
	std::lock_guard<std::mutex> lock(config_mutex);
	if (settings.refresh_token != youtube.refresh_token ||
	    (settings.route != YouTubeRoute::Direct && !credential_id.empty()))
		replace_credential(settings.refresh_token);
	if (session_only)
		QMetaObject::invokeMethod(qApp, show_storage_notice, Qt::QueuedConnection);
	youtube = settings;
	youtube.previously_paired |= !youtube.upload_token.empty();
	youtube.previously_direct |= !youtube.refresh_token.empty();
	if (!write_config(youtube))
		notify_user(
			"Better Clips: could not save the YouTube connection. Check your settings folder permissions.");
	QMetaObject::invokeMethod(qApp, refresh_youtube_account, Qt::QueuedConnection);
}

bool save_settings(const YouTubeSettings &account)
{
	std::lock_guard<std::mutex> lock(config_mutex);
	if (!write_config(account))
		return false;
	youtube = account;
	startup_notice.clear();
	return true;
}

void notify_user(const std::string &message, const std::string &link)
{
	QString text = QString::fromStdString(message);
	QString url = QString::fromStdString(link);
	QMetaObject::invokeMethod(
		qApp,
		[text, url]() {
			if (!ui_alive)
				return;
			if (!url.isEmpty())
				QApplication::clipboard()->setText(url);
			show_dock_message(text);
			auto *window = static_cast<QMainWindow *>(obs_frontend_get_main_window());
			if (!window)
				return;
			/* OBS's status bar covers QStatusBar's own message area and shows
			 * text through its own showMessage slot, so call that by name. */
			QStatusBar *bar = window->statusBar();
			if (!QMetaObject::invokeMethod(bar, "showMessage", Q_ARG(QString, text), Q_ARG(int, 15000)))
				bar->showMessage(text, 15000);
		},
		Qt::QueuedConnection);
}

bool obs_module_load(void)
{
	return true;
}

void obs_module_post_load(void)
{
	/* Wait until OBS has opened every module; either filename can load first. */
	if (auto *legacy = obs_get_module("obs-replay-r2"))
		startup_notice = QString("Better Clips is disabled. Remove the old plugin at %1 and restart OBS.")
					 .arg(QString::fromUtf8(obs_get_module_binary_path(legacy)));
	else if (!migrate_config())
		startup_notice =
			"Better Clips is disabled. Could not recover your previous settings. Check the config file and its permissions, then restart OBS.";
	obs_frontend_add_tools_menu_item(
		obs_module_text("ReplayR2.Settings"), [](void *) { show_settings_dialog(); }, nullptr);
	obs_frontend_add_event_callback(on_frontend_event, nullptr);
	if (!startup_notice.isEmpty()) {
		obs_log(LOG_WARNING, "%s", startup_notice.toUtf8().constData());
		create_save_dock();
		return;
	}
	initialized = true;
	curl_global_init(CURL_GLOBAL_DEFAULT);
	register_better_clips_output();

	save_hotkey = obs_hotkey_register_frontend("ReplayR2.Save", obs_module_text("ReplayR2.Save"), on_save_hotkey,
						   nullptr);
	load_config();
	if (!QFileInfo::exists(QString::fromStdString(config_path()))) {
		enable_replay_buffer_in_profile();
		bind_default_hotkey();
	}

	obs_frontend_add_save_callback(on_frontend_save, nullptr);
	create_save_dock();

	start_youtube_reviews();
	uploader_start();
	obs_log(LOG_INFO, "plugin loaded successfully (version %s)", PLUGIN_VERSION);
}

void obs_module_unload(void)
{
	obs_frontend_remove_event_callback(on_frontend_event, nullptr);
	if (!initialized)
		return;
	stop_youtube_reviews();
	stop_youtube_disconnect();
	obs_frontend_remove_save_callback(on_frontend_save, nullptr);
	stop_replay_output();
	uploader_stop();
	curl_global_cleanup();
	obs_log(LOG_INFO, "plugin unloaded");
}
