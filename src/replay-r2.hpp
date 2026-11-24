#pragma once

#include <obs-module.h>

#include <cstdint>
#include <string>
#include <vector>

/* ---- Settings (plugin-main.cpp) ---------------------------------------- */

struct R2Config {
	/* When set, clips upload through the clips app (web/) instead of S3. */
	std::string app_url;      /* e.g. https://clips.<you>.workers.dev */
	std::string upload_token; /* from the app's setup code */

	std::string s3_url;     /* https://<account>.r2.cloudflarestorage.com/<bucket> */
	std::string access_key; /* R2 API token: Access Key ID */
	std::string secret_key; /* R2 API token: Secret Access Key */
	std::string folder = "replays";
	std::string public_url; /* optional, e.g. https://pub-xxxx.r2.dev */
};

R2Config get_config();
void set_config(const R2Config &config);

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
	int color_primaries = 2, color_trc = 2, colorspace = 2, color_range = 0; /* FFmpeg enums */
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
	R2Config config;

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

/* ---- Upload (s3-upload.cpp, uploader.cpp) ------------------------------ */

bool s3_put_object(const R2Config &config, const std::string &key, const std::vector<uint8_t> &body,
		   const char *content_type, std::string &error);

/* Uploads through the clips app; key is set to where the clip landed. */
bool app_upload(const R2Config &config, const std::string &name, const std::vector<uint8_t> &mp4, std::string &key,
		std::string &error);

/* Checks that the clips app accepts the upload token. */
bool app_check(const R2Config &config, std::string &error);

/* True for https:// URLs, and plain http only on this computer, for testing. */
bool secure_url(const std::string &url);

/* Joins the folder and file name into an object key. */
std::string object_key(const R2Config &config, const std::string &name);

void uploader_start();
void uploader_stop();              /* finishes queued uploads first */
void uploader_enqueue(Clip *clip); /* takes ownership */

/* ---- The output that keeps the replay in memory (replay-output.cpp) ---- */

void register_replay_r2_output();

/* Asks a running replay_r2_output to save the last N seconds. */
void replay_r2_request_save(obs_output_t *output);
