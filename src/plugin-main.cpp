/*
Better Clips for OBS
Keeps an in-memory replay buffer and uploads saved clips straight to
Cloudflare R2, without writing them to disk.

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

#include "replay-r2.hpp"
#include "plugin-support.h"

#include <obs-frontend-api.h>
#include <util/config-file.h>
#include <util/platform.h>

#include <curl/curl.h>

#include <QApplication>
#include <QClipboard>
#include <QDir>
#include <QFileInfo>
#include <QMainWindow>
#include <QMetaObject>
#include <QStatusBar>

#include <cstring>
#include <mutex>

void wait_for_tests();

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE(PLUGIN_NAME, "en-US")

namespace {

std::mutex config_mutex;
R2Config config;
YouTubeSettings youtube;
obs_hotkey_id save_hotkey = OBS_INVALID_HOTKEY_ID;
obs_output_t *replay_output = nullptr; /* our in-memory replay buffer */
bool ui_alive = true;
bool initialized = false;
bool just_set_up = false; /* the install script's setup code was applied */
bool dock_placed = false; /* the dock was put next to Controls once */

std::string config_path()
{
	char *path = obs_module_config_path("config.json");
	std::string result = path ? path : "";
	bfree(path);
	return result;
}

bool migrate_config()
{
	const QFileInfo target(QString::fromStdString(config_path()));
	const QDir dir = target.dir();
	const QString legacy = QDir::cleanPath(dir.filePath("../obs-replay-r2/config.json"));
	if (target.exists() || QFile::exists(target.filePath() + ".bak") || !QFile::exists(legacy))
		return true;
	return dir.mkpath(".") && QFile::copy(legacy, target.filePath());
}

void load_config()
{
	obs_data_t *data = obs_data_create_from_json_file_safe(config_path().c_str(), "bak");
	if (!data)
		return;
	obs_data_set_default_string(data, "folder", "replays");
	obs_data_set_default_bool(data, "start_replay_buffer", true);
	config.app_url = obs_data_get_string(data, "app_url");
	config.upload_token = obs_data_get_string(data, "upload_token");
	config.s3_url = obs_data_get_string(data, "s3_url");
	config.access_key = obs_data_get_string(data, "access_key");
	config.secret_key = obs_data_get_string(data, "secret_key");
	config.folder = obs_data_get_string(data, "folder");
	config.public_url = obs_data_get_string(data, "public_url");
	config.start_replay_buffer = obs_data_get_bool(data, "start_replay_buffer");
	dock_placed = obs_data_get_bool(data, "dock_placed");
	obs_data_set_default_int(data, "destination", config.app_url.empty() && !config.s3_url.empty() ? 1 : 0);
	youtube.destination = static_cast<Destination>(obs_data_get_int(data, "destination"));
	youtube.route = static_cast<YouTubeRoute>(obs_data_get_int(data, "youtube_route"));
	youtube.refresh_token = obs_data_get_string(data, "youtube_refresh_token");
	youtube.app_url = obs_data_get_string(data, "youtube_app_url");
	youtube.upload_token = obs_data_get_string(data, "youtube_upload_token");
	youtube.channel_id = obs_data_get_string(data, "youtube_channel_id");
	youtube.channel_title = obs_data_get_string(data, "youtube_channel_title");
	obs_data_set_default_string(data, "youtube_privacy", "unlisted");
	obs_data_set_default_string(data, "youtube_title", "{game} - {date} {time}");
	obs_data_set_default_int(data, "youtube_audio_track", 1);
	youtube.privacy = obs_data_get_string(data, "youtube_privacy");
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
bool write_config(const R2Config &next, const YouTubeSettings &account)
{
	obs_data_t *data = obs_data_create();
	{
		const auto &config = next;
		const auto &youtube = account;
		obs_data_set_string(data, "app_url", config.app_url.c_str());
		obs_data_set_string(data, "upload_token", config.upload_token.c_str());
		obs_data_set_string(data, "s3_url", config.s3_url.c_str());
		obs_data_set_string(data, "access_key", config.access_key.c_str());
		obs_data_set_string(data, "secret_key", config.secret_key.c_str());
		obs_data_set_string(data, "folder", config.folder.c_str());
		obs_data_set_string(data, "public_url", config.public_url.c_str());
		obs_data_set_bool(data, "start_replay_buffer", config.start_replay_buffer);
		obs_data_set_int(data, "destination", static_cast<int>(youtube.destination));
		obs_data_set_int(data, "youtube_route", static_cast<int>(youtube.route));
		obs_data_set_string(data, "youtube_refresh_token", youtube.refresh_token.c_str());
		obs_data_set_string(data, "youtube_app_url", youtube.app_url.c_str());
		obs_data_set_string(data, "youtube_upload_token", youtube.upload_token.c_str());
		obs_data_set_string(data, "youtube_channel_id", youtube.channel_id.c_str());
		obs_data_set_string(data, "youtube_channel_title", youtube.channel_title.c_str());
		obs_data_set_string(data, "youtube_privacy", youtube.privacy.c_str());
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
	write_config(config, youtube);
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
	replay_output = obs_output_create("replay_r2_output", "Better Clips", nullptr, nullptr);

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

/* The install script leaves the setup code from the clips app here. Applying
 * it while OBS loads plugins sets everything up on OBS's first start: the
 * upload settings, the Replay Buffer and a hotkey. */
void apply_pending_setup_code()
{
	char *path = obs_module_config_path("setup-code.txt");
	std::string file = path ? path : "";
	bfree(path);

	char *text = os_quick_read_utf8_file(file.c_str());
	if (!text)
		return;
	R2Config next = get_config();
	bool applied = apply_setup_code(text, next);
	bfree(text);
	os_unlink(file.c_str());

	if (!applied) {
		obs_log(LOG_WARNING, "Ignored %s: not a setup code", file.c_str());
		return;
	}
	next.start_replay_buffer = true;
	youtube.destination = next.app_url.empty() ? Destination::S3 : Destination::ClipsApp;
	enable_replay_buffer_in_profile();
	bind_default_hotkey();
	set_config(next);
	just_set_up = true;
	obs_log(LOG_INFO, "Applied the setup code from the install script");
}

/* Starts OBS's Replay Buffer, which starts ours, unless that is turned off. */
void start_obs_replay_buffer()
{
	if (!get_config().start_replay_buffer || obs_frontend_replay_buffer_active())
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
		save_replay_to_r2();
}

void on_frontend_event(enum obs_frontend_event event, void *)
{
	switch (event) {
	case OBS_FRONTEND_EVENT_FINISHED_LOADING:
		/* Until OBS has saved a layout with the dock in it, put it next
		 * to Controls. After that, OBS remembers where the user keeps it. */
		if (!dock_placed)
			place_save_dock();
		start_obs_replay_buffer();
		if (just_set_up) {
			just_set_up = false;
			check_connection_async(get_config());
		}
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

bool replay_r2_running()
{
	return replay_output && obs_output_active(replay_output);
}

void save_replay_to_r2()
{
	if (!replay_r2_running()) {
		notify_user("Better Clips: start the Replay Buffer first");
		return;
	}
	R2Config current = get_config();
	auto yt = get_youtube_settings();
	if (yt.destination == Destination::YouTube &&
	    (yt.route == YouTubeRoute::Direct ? !youtube_direct_available() || yt.refresh_token.empty()
					      : yt.app_url.empty() || yt.upload_token.empty())) {
		notify_user("Sign in with YouTube in Tools > Better Clips Settings");
		return;
	}
	if ((yt.destination == Destination::ClipsApp && current.app_url.empty()) ||
	    (yt.destination == Destination::S3 && current.s3_url.empty())) {
		notify_user("Better Clips: connect your Better Clips app in Tools > Better Clips Settings");
		return;
	}
	replay_r2_request_save(replay_output);
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

R2Config get_config()
{
	std::lock_guard<std::mutex> lock(config_mutex);
	return config;
}

YouTubeSettings get_youtube_settings()
{
	std::lock_guard<std::mutex> lock(config_mutex);
	return youtube;
}

void set_youtube_settings(const YouTubeSettings &settings)
{
	std::lock_guard<std::mutex> lock(config_mutex);
	youtube = settings;
	if (!write_config(config, youtube))
		notify_user(
			"Better Clips: could not save the YouTube connection. Check your settings folder permissions.");
}

void set_config(const R2Config &new_config)
{
	save_settings(new_config, get_youtube_settings());
}

bool save_settings(const R2Config &next, const YouTubeSettings &account)
{
	std::lock_guard<std::mutex> lock(config_mutex);
	if (!write_config(next, account))
		return false;
	config = next;
	youtube = account;
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
	const char *problem = nullptr;
	if (obs_get_module("obs-replay-r2"))
		problem =
			"Better Clips: remove the old obs-replay-r2 plugin and restart OBS. Better Clips is disabled.";
	else if (!migrate_config())
		problem =
			"Better Clips: could not copy your previous settings. Check file permissions and restart OBS.";
	if (problem) {
		obs_log(LOG_WARNING, "%s", problem);
		notify_user(problem);
		return;
	}
	initialized = true;
	curl_global_init(CURL_GLOBAL_DEFAULT);
	register_replay_r2_output();

	save_hotkey = obs_hotkey_register_frontend("ReplayR2.Save", obs_module_text("ReplayR2.Save"), on_save_hotkey,
						   nullptr);
	load_config();
	apply_pending_setup_code();

	obs_frontend_add_event_callback(on_frontend_event, nullptr);
	obs_frontend_add_save_callback(on_frontend_save, nullptr);
	obs_frontend_add_tools_menu_item(
		obs_module_text("ReplayR2.Settings"), [](void *) { show_settings_dialog(); }, nullptr);
	create_save_dock();

	start_youtube_reviews();
	uploader_start();
	obs_log(LOG_INFO, "plugin loaded successfully (version %s)", PLUGIN_VERSION);
}

void obs_module_unload(void)
{
	if (!initialized)
		return;
	stop_youtube_reviews();
	stop_youtube_disconnect();
	obs_frontend_remove_event_callback(on_frontend_event, nullptr);
	obs_frontend_remove_save_callback(on_frontend_save, nullptr);
	stop_replay_output();
	uploader_stop();
	wait_for_tests();
	curl_global_cleanup();
	obs_log(LOG_INFO, "plugin unloaded");
}
