#pragma once

#include <obs-module.h>

#include <QString>
#include "youtube.hpp"

#include <cstdint>
#include <atomic>
#include <string>
#include <vector>

/* ---- Settings (plugin-main.cpp) ---------------------------------------- */

/* Saves the last N seconds and uploads them, or tells the user what's
 * missing. Call on the UI thread. (plugin-main.cpp) */
void save_replay();
bool replay_running();

/* The replay length in seconds, OBS's Maximum Replay Time. Setting it also
 * applies it to the running in-memory buffer. (plugin-main.cpp) */
int get_replay_seconds();
void set_replay_seconds(int seconds);
void sync_replay_seconds();

void show_settings_dialog(); /* settings-dialog.cpp */

/* ---- The dock with the Save button (save-dock.cpp), UI thread only ---- */

void create_save_dock();
void update_save_dock();
/* Puts the dock next to OBS's Controls dock and shows it, unless Controls
 * is hidden. */
void place_save_dock();
void show_dock_message(const QString &message);

/* Shows a message in the OBS status bar and, when link is set, copies it to
 * the clipboard. Safe to call from any thread. */
void notify_user(const std::string &message, const std::string &link = {});

/* ---- A saved replay, still in memory (replay-output.cpp, memory-mux.cpp) - */

struct VideoTrack {
	std::string codec; /* "h264", "hevc", "av1" */
	std::vector<uint8_t> extradata;
	uint32_t width = 0, height = 0;
	uint32_t fps_num = 0, fps_den = 1;
	int64_t bitrate_kbps = 0;
	/* ITU-T H.273 codes, as an MP4 colr box takes them; 2 is unspecified.
	 * color_range is 1 for limited (TV) range and 2 for full range. */
	int color_primaries = 2, color_trc = 2, colorspace = 2, color_range = 1;
};

struct AudioTrack {
	size_t track_idx = 0; /* encoder_packet::track_idx */
	std::string codec;    /* "aac", "opus" */
	std::vector<uint8_t> extradata;
	uint32_t sample_rate = 48000;
	size_t channels = 2;
	size_t frame_size = 1024;
	int64_t bitrate_kbps = 0;
};

struct Clip {
	std::string name; /* file name, e.g. Replay_2026-11-24_14-03-22.mp4 */
	VideoTrack video;
	std::vector<AudioTrack> audio;
	std::vector<encoder_packet> packets; /* referenced, sorted by dts_usec */
	YouTubeSettings youtube;
	int youtube_audio_index = -1; /* packet track for the selected mixer, or absent */
	std::string game;
	time_t recorded_at = 0;
	std::string save_dir; /* OBS's recording folder, for a clip that can't upload */

	Clip() = default;
	Clip(const Clip &) = delete;
	Clip &operator=(const Clip &) = delete;
	~Clip()
	{
		for (encoder_packet &pkt : packets)
			obs_encoder_packet_release(&pkt);
	}
};

/* Writes the clip as an MP4 into memory. Returns false and sets error on failure. */
bool mux_clip_to_mp4(const Clip &clip, std::vector<uint8_t> &mp4, std::string &error);

/* Kept across retries of ONE clip. A lost reply must never start a second video. */
struct YouTubeSession {
	std::string url, clip_id, video_id;
	bool permanent_failure = false;
};
bool youtube_upload(const Clip &clip, const YouTubeUpload &details, const std::vector<uint8_t> &mp4,
		    YouTubeSession &session, std::string &link, std::string &error,
		    const std::atomic<bool> &stopping = false);
class QObject;
void youtube_watch(QObject *owner, const YouTubeSettings &settings, const std::string &clip_id,
		   const std::string &title);

void uploader_start();
void uploader_stop();              /* finishes queued uploads, or saves them to disk */
void uploader_enqueue(Clip *clip); /* takes ownership */

/* ---- The output that keeps the replay in memory (replay-output.cpp) ---- */

void register_better_clips_output();

/* Asks a running better_clips_output to save the last N seconds. */
void replay_request_save(obs_output_t *output);

/* The focused app's name, or "" when OBS is focused or it's unknown
 * (focused-app.cpp). */
std::string focused_app_name();

bool youtube_upload(const Clip &clip, const YouTubeUpload &details, const std::vector<uint8_t> &mp4,
		    YouTubeSession &session, std::string &link, std::string &error, const std::atomic<bool> &stopping,
		    QObject *owner);

void youtube_watch(QObject *owner, const YouTubeSettings &settings, const std::string &clip_id,
		   const std::string &title, const std::string &path, std::function<void()> finish);

/* Reserve before accepting a press; enqueue or cancel exactly once. */
bool uploader_reserve();
void uploader_cancel_reservation();

bool save_settings(const YouTubeSettings &account);
void refresh_youtube_account();
QString plugin_startup_notice();
bool plugin_disabled();
void record_upload_success();
QString destination_setup_action();
void retry_plugin_buffer();
