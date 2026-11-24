/* An OBS output that keeps the last N seconds of encoded packets in memory,
 * like OBS's own "replay_buffer" output (plugins/obs-ffmpeg/obs-ffmpeg-mux.c),
 * but hands saved clips to the uploader instead of writing a file.
 *
 * It is attached to the same encoders as OBS's replay buffer, so it adds no
 * encoding work, and packet data is reference counted, so both buffers share
 * the same memory. */

#include "replay-r2.hpp"
#include "plugin-support.h"

#include <util/platform.h>

extern "C" {
#include <libavutil/pixfmt.h>
}

#include <algorithm>
#include <cctype>
#include <atomic>
#include <ctime>
#include <deque>
#include <mutex>
#include <random>
#include <string>

namespace {

struct ReplayR2 {
	obs_output_t *output;

	std::mutex mutex;
	std::deque<encoder_packet> packets;
	std::deque<int64_t> keyframes; /* dts_usec of each video keyframe in packets */
	int64_t cur_size = 0;
	int64_t cur_time = 0; /* dts_usec of the oldest packet */

	int64_t max_time_usec = 0;
	int64_t max_size_bytes = 0;

	std::atomic<bool> active{false};
	std::atomic<int64_t> save_ts{0};       /* save once a packet reaches this sys time */
	std::atomic<time_t> save_wall_time{0}; /* for the file name */
	std::string save_scene;                /* for the file name, guarded by mutex */
};

void clear(ReplayR2 *r)
{
	for (encoder_packet &pkt : r->packets)
		obs_encoder_packet_release(&pkt);
	r->packets.clear();
	r->keyframes.clear();
	r->cur_size = 0;
	r->cur_time = 0;
}

/* Drops the oldest packet; returns true if it was a video keyframe. */
bool purge_front(ReplayR2 *r)
{
	encoder_packet pkt = r->packets.front();
	r->packets.pop_front();

	bool keyframe = pkt.type == OBS_ENCODER_VIDEO && pkt.keyframe;
	if (keyframe)
		r->keyframes.pop_front();

	if (r->packets.empty()) {
		r->cur_size = 0;
		r->cur_time = 0;
	} else {
		r->cur_size -= (int64_t)pkt.size;
		r->cur_time = r->packets.front().dts_usec;
	}
	obs_encoder_packet_release(&pkt);
	return keyframe;
}

/* Drops one whole group of pictures, so the buffer always starts on a keyframe. */
void purge_gop(ReplayR2 *r)
{
	if (!purge_front(r))
		return;
	while (!r->packets.empty()) {
		const encoder_packet &next = r->packets.front();
		if (next.type == OBS_ENCODER_VIDEO && next.keyframe)
			return;
		purge_front(r);
	}
}

void purge(ReplayR2 *r, const encoder_packet *incoming)
{
	if (r->max_size_bytes) {
		while (!r->packets.empty() && r->keyframes.size() > 2 &&
		       r->cur_size + (int64_t)incoming->size > r->max_size_bytes)
			purge_gop(r);
	}
	/* Drop the oldest group of pictures only while the rest still covers the
	 * whole length, so a clip is never shorter than the length the user set. */
	while (r->keyframes.size() > 2 && incoming->dts_usec - r->keyframes[1] >= r->max_time_usec)
		purge_gop(r);
}

void fill_video_track(VideoTrack &track, obs_encoder_t *encoder)
{
	track.codec = obs_encoder_get_codec(encoder);
	uint8_t *extra = nullptr;
	size_t extra_size = 0;
	if (obs_encoder_get_extra_data(encoder, &extra, &extra_size))
		track.extradata.assign(extra, extra + extra_size);
	track.width = obs_encoder_get_width(encoder);
	track.height = obs_encoder_get_height(encoder);

	obs_data_t *settings = obs_encoder_get_settings(encoder);
	track.bitrate_kbps = obs_data_get_int(settings, "bitrate");
	obs_data_release(settings);

	const struct video_output_info *info = video_output_get_info(obs_get_video());
	track.fps_num = info->fps_num;
	track.fps_den = info->fps_den;

	/* Same color tags OBS writes into its own recordings. */
	switch (info->colorspace) {
	case VIDEO_CS_601:
		track.color_primaries = AVCOL_PRI_SMPTE170M;
		track.color_trc = AVCOL_TRC_SMPTE170M;
		track.colorspace = AVCOL_SPC_SMPTE170M;
		break;
	case VIDEO_CS_DEFAULT:
	case VIDEO_CS_709:
		track.color_primaries = AVCOL_PRI_BT709;
		track.color_trc = AVCOL_TRC_BT709;
		track.colorspace = AVCOL_SPC_BT709;
		break;
	case VIDEO_CS_SRGB:
		track.color_primaries = AVCOL_PRI_BT709;
		track.color_trc = AVCOL_TRC_IEC61966_2_1;
		track.colorspace = AVCOL_SPC_BT709;
		break;
	case VIDEO_CS_2100_PQ:
		track.color_primaries = AVCOL_PRI_BT2020;
		track.color_trc = AVCOL_TRC_SMPTE2084;
		track.colorspace = AVCOL_SPC_BT2020_NCL;
		break;
	case VIDEO_CS_2100_HLG:
		track.color_primaries = AVCOL_PRI_BT2020;
		track.color_trc = AVCOL_TRC_ARIB_STD_B67;
		track.colorspace = AVCOL_SPC_BT2020_NCL;
		break;
	}
	track.color_range = info->range == VIDEO_RANGE_FULL ? AVCOL_RANGE_JPEG : AVCOL_RANGE_MPEG;
}

void fill_audio_track(AudioTrack &track, obs_encoder_t *encoder, size_t idx)
{
	track.track_idx = idx;
	track.codec = obs_encoder_get_codec(encoder);
	uint8_t *extra = nullptr;
	size_t extra_size = 0;
	if (obs_encoder_get_extra_data(encoder, &extra, &extra_size))
		track.extradata.assign(extra, extra + extra_size);
	track.sample_rate = obs_encoder_get_sample_rate(encoder);
	track.frame_size = obs_encoder_get_frame_size(encoder);
	track.channels = audio_output_get_channels(obs_get_audio());

	obs_data_t *settings = obs_encoder_get_settings(encoder);
	track.bitrate_kbps = obs_data_get_int(settings, "bitrate");
	obs_data_release(settings);
}

/* Keeps letters, digits and dashes, so the name reads the same in a URL. */
std::string url_safe(const std::string &text)
{
	std::string out;
	for (unsigned char c : text) {
		if (isalnum(c) && c < 0x80)
			out += (char)c;
		else if (!out.empty() && out.back() != '-')
			out += '-';
	}
	while (!out.empty() && out.back() == '-')
		out.pop_back();
	return out.substr(0, 40);
}

/* A name people can browse: a folder per day, then the time and the scene,
 * e.g. "2026-11-24/14-35-07_Valorant.mp4". With a public URL, a short random
 * code is appended so nobody can guess a clip's link from the time. */
std::string clip_name(time_t wall_time, const std::string &scene, bool add_code)
{
	struct tm local;
#ifdef _WIN32
	localtime_s(&local, &wall_time);
#else
	localtime_r(&wall_time, &local);
#endif
	char stamp[32];
	strftime(stamp, sizeof(stamp), "%Y-%m-%d/%H-%M-%S", &local);
	std::string name = stamp;

	std::string label = url_safe(scene);
	if (!label.empty())
		name += "_" + label;

	if (add_code) {
		static const char alphabet[] = "abcdefghijkmnpqrstuvwxyz23456789";
		std::random_device random;
		name += '_';
		for (int i = 0; i < 6; i++)
			name += alphabet[random() % (sizeof(alphabet) - 1)];
	}
	return name + ".mp4";
}

/* Copies the buffer into a clip with timestamps starting at zero, sorted by
 * dts_usec, as replay_buffer_save() does in obs-ffmpeg-mux.c. */
Clip *snapshot(ReplayR2 *r)
{
	Clip *clip = new Clip();
	clip->config = get_config();

	clip->name = clip_name(r->save_wall_time, r->save_scene, !clip->config.public_url.empty());

	fill_video_track(clip->video, obs_output_get_video_encoder(r->output));
	for (size_t i = 0; i < MAX_OUTPUT_AUDIO_ENCODERS; i++) {
		obs_encoder_t *encoder = obs_output_get_audio_encoder(r->output, i);
		if (encoder) {
			clip->audio.emplace_back();
			fill_audio_track(clip->audio.back(), encoder, i);
		}
	}

	bool found_video = false;
	bool found_audio[MAX_OUTPUT_AUDIO_ENCODERS] = {false};
	int64_t video_offset = 0, video_pts_offset = 0;
	int64_t audio_offsets[MAX_OUTPUT_AUDIO_ENCODERS] = {0};
	int64_t audio_dts_offsets[MAX_OUTPUT_AUDIO_ENCODERS] = {0};

	clip->packets.reserve(r->packets.size());
	for (const encoder_packet &src : r->packets) {
		encoder_packet pkt;
		obs_encoder_packet_ref(&pkt, const_cast<encoder_packet *>(&src));

		if (pkt.type == OBS_ENCODER_VIDEO) {
			if (!found_video) {
				video_pts_offset = pkt.pts;
				video_offset = video_pts_offset * 1000000 / pkt.timebase_den;
				found_video = true;
			}
			pkt.dts_usec -= video_offset;
			pkt.dts -= video_pts_offset;
			pkt.pts -= video_pts_offset;
		} else {
			size_t t = pkt.track_idx;
			if (!found_audio[t]) {
				found_audio[t] = true;
				audio_offsets[t] = pkt.dts_usec;
				audio_dts_offsets[t] = pkt.dts;
			}
			pkt.dts_usec -= audio_offsets[t];
			pkt.dts -= audio_dts_offsets[t];
			pkt.pts -= audio_dts_offsets[t];
		}
		clip->packets.push_back(pkt);
	}
	std::stable_sort(clip->packets.begin(), clip->packets.end(),
			 [](const encoder_packet &a, const encoder_packet &b) { return a.dts_usec < b.dts_usec; });
	return clip;
}

const char *get_name(void *)
{
	return "Replay to R2 (in-memory replay buffer)";
}

void *create(obs_data_t *, obs_output_t *output)
{
	ReplayR2 *r = new ReplayR2();
	r->output = output;
	return r;
}

void destroy(void *data)
{
	ReplayR2 *r = (ReplayR2 *)data;
	{
		std::lock_guard<std::mutex> lock(r->mutex);
		clear(r);
	}
	delete r;
}

/* Takes new limits, even while running: a longer limit keeps more from now
 * on, a shorter one drops the oldest packets with the next packet. */
void update(void *data, obs_data_t *settings)
{
	ReplayR2 *r = (ReplayR2 *)data;
	std::lock_guard<std::mutex> lock(r->mutex);
	r->max_time_usec = obs_data_get_int(settings, "max_time_sec") * 1000000LL;
	r->max_size_bytes = obs_data_get_int(settings, "max_size_mb") * 1024 * 1024;
}

bool start(void *data)
{
	ReplayR2 *r = (ReplayR2 *)data;
	if (!obs_output_can_begin_data_capture(r->output, 0))
		return false;
	if (!obs_output_initialize_encoders(r->output, 0))
		return false;

	r->save_ts = 0;
	r->active = true;
	obs_output_begin_data_capture(r->output, 0);
	return true;
}

void stop(void *data, uint64_t)
{
	ReplayR2 *r = (ReplayR2 *)data;
	r->active = false;
	obs_output_end_data_capture(r->output);
	std::lock_guard<std::mutex> lock(r->mutex);
	clear(r);
}

void encoded_packet(void *data, struct encoder_packet *packet)
{
	ReplayR2 *r = (ReplayR2 *)data;
	if (!r->active)
		return;

	if (!packet) { /* encoder failure */
		r->active = false;
		obs_output_signal_stop(r->output, OBS_OUTPUT_ENCODE_ERROR);
		return;
	}

	std::lock_guard<std::mutex> lock(r->mutex);

	/* We may have joined the shared encoder mid-GOP: start on a keyframe. */
	bool is_keyframe = packet->type == OBS_ENCODER_VIDEO && packet->keyframe;
	if (r->packets.empty() && !is_keyframe)
		return;

	purge(r, packet);

	encoder_packet pkt;
	obs_encoder_packet_ref(&pkt, packet);
	if (r->packets.empty())
		r->cur_time = pkt.dts_usec;
	r->cur_size += (int64_t)pkt.size;
	r->packets.push_back(pkt);
	if (is_keyframe)
		r->keyframes.push_back(pkt.dts_usec);

	int64_t save_ts = r->save_ts;
	if (save_ts && packet->sys_dts_usec >= save_ts) {
		r->save_ts = 0;
		uploader_enqueue(snapshot(r));
	}
}

} // namespace

void replay_r2_request_save(obs_output_t *output)
{
	ReplayR2 *r = (ReplayR2 *)obs_obj_get_data(output);
	if (!r || !r->active)
		return;
	/* The scene on screen now; the program output is a transition, whose
	 * active source is the current scene. */
	std::string scene;
	obs_source_t *program = obs_get_output_source(0);
	if (program) {
		obs_source_t *active = obs_source_get_type(program) == OBS_SOURCE_TYPE_TRANSITION
					       ? obs_transition_get_active_source(program)
					       : obs_source_get_ref(program);
		if (active) {
			scene = obs_source_get_name(active);
			obs_source_release(active);
		}
		obs_source_release(program);
	}
	{
		std::lock_guard<std::mutex> lock(r->mutex);
		r->save_scene = scene;
	}
	r->save_wall_time = time(nullptr);
	r->save_ts = (int64_t)(os_gettime_ns() / 1000);
}

void register_replay_r2_output()
{
	struct obs_output_info info = {};
	info.id = "replay_r2_output";
	info.flags = OBS_OUTPUT_AV | OBS_OUTPUT_ENCODED | OBS_OUTPUT_MULTI_TRACK;
	info.get_name = get_name;
	info.create = create;
	info.destroy = destroy;
	info.start = start;
	info.stop = stop;
	info.update = update;
	info.encoded_packet = encoded_packet;
	obs_register_output(&info);
}
