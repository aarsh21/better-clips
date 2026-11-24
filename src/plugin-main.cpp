/*
Replay to R2 for OBS
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
#include <util/platform.h>

#include <curl/curl.h>

#include <QApplication>
#include <QClipboard>
#include <QMainWindow>
#include <QMetaObject>
#include <QStatusBar>

#include <mutex>

void show_settings_dialog();
void wait_for_tests();

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE(PLUGIN_NAME, "en-US")

namespace {

std::mutex config_mutex;
R2Config config;
obs_hotkey_id save_hotkey = OBS_INVALID_HOTKEY_ID;
obs_output_t *replay_output = nullptr; /* our in-memory replay buffer */
bool ui_alive = true;

std::string config_path()
{
	char *path = obs_module_config_path("config.json");
	std::string result = path ? path : "";
	bfree(path);
	return result;
}

void load_config()
{
	obs_data_t *data = obs_data_create_from_json_file_safe(config_path().c_str(), "bak");
	if (!data)
		return;
	obs_data_set_default_string(data, "folder", "replays");
	config.app_url = obs_data_get_string(data, "app_url");
	config.upload_token = obs_data_get_string(data, "upload_token");
	config.s3_url = obs_data_get_string(data, "s3_url");
	config.access_key = obs_data_get_string(data, "access_key");
	config.secret_key = obs_data_get_string(data, "secret_key");
	config.folder = obs_data_get_string(data, "folder");
	config.public_url = obs_data_get_string(data, "public_url");

	obs_data_array_t *hotkey = obs_data_get_array(data, "save_hotkey");
	obs_hotkey_load(save_hotkey, hotkey);
	obs_data_array_release(hotkey);
	obs_data_release(data);
}

void save_config()
{
	obs_data_t *data = obs_data_create();
	{
		std::lock_guard<std::mutex> lock(config_mutex);
		obs_data_set_string(data, "app_url", config.app_url.c_str());
		obs_data_set_string(data, "upload_token", config.upload_token.c_str());
		obs_data_set_string(data, "s3_url", config.s3_url.c_str());
		obs_data_set_string(data, "access_key", config.access_key.c_str());
		obs_data_set_string(data, "secret_key", config.secret_key.c_str());
		obs_data_set_string(data, "folder", config.folder.c_str());
		obs_data_set_string(data, "public_url", config.public_url.c_str());
	}
	obs_data_array_t *hotkey = obs_hotkey_save(save_hotkey);
	obs_data_set_array(data, "save_hotkey", hotkey);
	obs_data_array_release(hotkey);

	char *dir = obs_module_config_path("");
	os_mkdirs(dir);
	bfree(dir);
	if (!obs_data_save_json_safe(data, config_path().c_str(), "tmp", "bak"))
		obs_log(LOG_WARNING, "Could not save %s", config_path().c_str());
	obs_data_release(data);
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
	replay_output = obs_output_create("replay_r2_output", "Replay to R2", nullptr, nullptr);

	obs_data_t *obs_settings = obs_output_get_settings(obs_replay);
	obs_data_t *settings = obs_data_create();
	obs_data_set_int(settings, "max_time_sec", obs_data_get_int(obs_settings, "max_time_sec"));
	obs_data_set_int(settings, "max_size_mb", obs_data_get_int(obs_settings, "max_size_mb"));
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
		obs_log(LOG_INFO, "In-memory replay buffer started");
	else
		obs_log(LOG_ERROR, "Could not start in-memory replay buffer: %s",
			obs_output_get_last_error(replay_output));
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
	if (!pressed)
		return;
	if (!replay_output || !obs_output_active(replay_output)) {
		notify_user("Replay to R2: start the Replay Buffer first");
		return;
	}
	R2Config current = get_config();
	if (current.app_url.empty() && current.s3_url.empty()) {
		notify_user("Replay to R2: connect your clips app in Tools > Replay to R2 Settings");
		return;
	}
	replay_r2_request_save(replay_output);
}

void on_frontend_event(enum obs_frontend_event event, void *)
{
	switch (event) {
	case OBS_FRONTEND_EVENT_REPLAY_BUFFER_STARTED:
		start_replay_output();
		break;
	case OBS_FRONTEND_EVENT_REPLAY_BUFFER_STOPPING:
	case OBS_FRONTEND_EVENT_REPLAY_BUFFER_STOPPED:
		stop_replay_output();
		break;
	case OBS_FRONTEND_EVENT_EXIT:
		stop_replay_output();
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

R2Config get_config()
{
	std::lock_guard<std::mutex> lock(config_mutex);
	return config;
}

void set_config(const R2Config &new_config)
{
	{
		std::lock_guard<std::mutex> lock(config_mutex);
		config = new_config;
	}
	save_config();
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
	curl_global_init(CURL_GLOBAL_DEFAULT);
	register_replay_r2_output();

	save_hotkey = obs_hotkey_register_frontend("ReplayR2.Save", obs_module_text("ReplayR2.Save"), on_save_hotkey,
						   nullptr);
	load_config();

	obs_frontend_add_event_callback(on_frontend_event, nullptr);
	obs_frontend_add_save_callback(on_frontend_save, nullptr);
	obs_frontend_add_tools_menu_item(
		obs_module_text("ReplayR2.Settings"), [](void *) { show_settings_dialog(); }, nullptr);

	uploader_start();
	obs_log(LOG_INFO, "plugin loaded successfully (version %s)", PLUGIN_VERSION);
	return true;
}

void obs_module_unload(void)
{
	obs_frontend_remove_event_callback(on_frontend_event, nullptr);
	obs_frontend_remove_save_callback(on_frontend_save, nullptr);
	stop_replay_output();
	uploader_stop();
	wait_for_tests();
	curl_global_cleanup();
	obs_log(LOG_INFO, "plugin unloaded");
}
