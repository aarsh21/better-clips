/* Muxes a replay's encoded packets into an MP4 held in memory. This replaces
 * the obs-ffmpeg-mux process OBS uses for its own replay buffer, which can
 * only write to a file. */

#include "replay-r2.hpp"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/mem.h>
}

#include <cstring>
#include <map>

/* FFmpeg 7 (libavformat 61) made the write callback's buffer const. */
#if LIBAVFORMAT_VERSION_MAJOR >= 61
#define WRITE_BUF_CONST const
#else
#define WRITE_BUF_CONST
#endif

namespace {

struct MemoryFile {
	std::vector<uint8_t> *data;
	int64_t pos = 0;
};

int memory_write(void *opaque, WRITE_BUF_CONST uint8_t *buf, int size)
{
	MemoryFile *file = (MemoryFile *)opaque;
	size_t end = (size_t)file->pos + (size_t)size;
	if (end > file->data->size())
		file->data->resize(end);
	memcpy(file->data->data() + file->pos, buf, (size_t)size);
	file->pos = (int64_t)end;
	return size;
}

/* The MP4 muxer seeks back to fill in box sizes and write the index. */
int64_t memory_seek(void *opaque, int64_t offset, int whence)
{
	MemoryFile *file = (MemoryFile *)opaque;
	int64_t size = (int64_t)file->data->size();
	switch (whence & ~AVSEEK_FORCE) {
	case AVSEEK_SIZE:
		return size;
	case SEEK_SET:
		break;
	case SEEK_CUR:
		offset += file->pos;
		break;
	case SEEK_END:
		offset += size;
		break;
	default:
		return -1;
	}
	if (offset < 0)
		return -1;
	file->pos = offset;
	return offset;
}

std::string av_error(int err)
{
	char buf[AV_ERROR_MAX_STRING_SIZE] = {0};
	av_strerror(err, buf, sizeof(buf));
	return buf;
}

bool set_extradata(AVCodecParameters *par, const std::vector<uint8_t> &extradata)
{
	if (extradata.empty())
		return true;
	par->extradata = (uint8_t *)av_mallocz(extradata.size() + AV_INPUT_BUFFER_PADDING_SIZE);
	if (!par->extradata)
		return false;
	memcpy(par->extradata, extradata.data(), extradata.size());
	par->extradata_size = (int)extradata.size();
	return true;
}

struct MuxContext {
	AVFormatContext *fmt = nullptr;
	AVIOContext *io = nullptr;
	AVPacket *packet = nullptr;

	~MuxContext()
	{
		av_packet_free(&packet);
		if (io) {
			av_freep(&io->buffer);
			avio_context_free(&io);
		}
		avformat_free_context(fmt);
	}
};

} // namespace

bool mux_clip_to_mp4(const Clip &clip, std::vector<uint8_t> &mp4, std::string &error)
{
	MuxContext ctx;
	MemoryFile file{&mp4};

	int ret = avformat_alloc_output_context2(&ctx.fmt, nullptr, "mp4", nullptr);
	if (ret < 0) {
		error = "Could not create MP4 muxer: " + av_error(ret);
		return false;
	}

	constexpr int IO_BUFFER_SIZE = 64 * 1024;
	uint8_t *io_buffer = (uint8_t *)av_malloc(IO_BUFFER_SIZE);
	ctx.io = avio_alloc_context(io_buffer, IO_BUFFER_SIZE, 1, &file, nullptr, memory_write, memory_seek);
	if (!ctx.io) {
		av_free(io_buffer);
		error = "Out of memory";
		return false;
	}
	ctx.fmt->pb = ctx.io;
	ctx.fmt->flags |= AVFMT_FLAG_CUSTOM_IO;

	/* Video stream */
	const AVCodecDescriptor *vdesc = avcodec_descriptor_get_by_name(clip.video.codec.c_str());
	if (!vdesc) {
		error = "Unsupported video codec: " + clip.video.codec;
		return false;
	}
	AVStream *vstream = avformat_new_stream(ctx.fmt, nullptr);
	AVCodecParameters *vpar = vstream->codecpar;
	vpar->codec_type = AVMEDIA_TYPE_VIDEO;
	vpar->codec_id = vdesc->id;
	vpar->width = (int)clip.video.width;
	vpar->height = (int)clip.video.height;
	vpar->bit_rate = clip.video.bitrate_kbps * 1000;
	vpar->color_primaries = (AVColorPrimaries)clip.video.color_primaries;
	vpar->color_trc = (AVColorTransferCharacteristic)clip.video.color_trc;
	vpar->color_space = (AVColorSpace)clip.video.colorspace;
	vpar->color_range = (AVColorRange)clip.video.color_range;
	if (!set_extradata(vpar, clip.video.extradata)) {
		error = "Out of memory";
		return false;
	}
	vstream->time_base = AVRational{(int)clip.video.fps_den, (int)clip.video.fps_num};
	vstream->avg_frame_rate = AVRational{(int)clip.video.fps_num, (int)clip.video.fps_den};

	/* One audio stream per OBS audio track */
	std::map<size_t, int> audio_stream_index;
	for (const AudioTrack &track : clip.audio) {
		const AVCodecDescriptor *adesc = avcodec_descriptor_get_by_name(track.codec.c_str());
		if (!adesc) {
			error = "Unsupported audio codec: " + track.codec;
			return false;
		}
		AVStream *astream = avformat_new_stream(ctx.fmt, nullptr);
		AVCodecParameters *apar = astream->codecpar;
		apar->codec_type = AVMEDIA_TYPE_AUDIO;
		apar->codec_id = adesc->id;
		apar->sample_rate = (int)track.sample_rate;
		apar->frame_size = (int)track.frame_size;
		apar->bit_rate = track.bitrate_kbps * 1000;
		av_channel_layout_default(&apar->ch_layout, (int)track.channels);
		if (track.channels == 5) /* same fix-up OBS applies: 5 channels is 4.1 */
			apar->ch_layout = AV_CHANNEL_LAYOUT_4POINT1;
		if (!set_extradata(apar, track.extradata)) {
			error = "Out of memory";
			return false;
		}
		astream->time_base = AVRational{1, (int)track.sample_rate};
		audio_stream_index[track.track_idx] = astream->index;
	}

	ret = avformat_write_header(ctx.fmt, nullptr);
	if (ret < 0) {
		error = "Could not write MP4 header: " + av_error(ret);
		return false;
	}

	ctx.packet = av_packet_alloc();
	for (const encoder_packet &pkt : clip.packets) {
		int index;
		if (pkt.type == OBS_ENCODER_VIDEO) {
			index = vstream->index;
		} else {
			auto it = audio_stream_index.find(pkt.track_idx);
			if (it == audio_stream_index.end())
				continue;
			index = it->second;
		}

		/* OBS timestamps count in units of 1/timebase_den. */
		const AVRational src_tb{1, (int)pkt.timebase_den};
		const AVRational dst_tb = ctx.fmt->streams[index]->time_base;

		/* Not reference counted, so the muxer copies the data it keeps. */
		ctx.packet->data = pkt.data;
		ctx.packet->size = (int)pkt.size;
		ctx.packet->stream_index = index;
		ctx.packet->pts = av_rescale_q_rnd(pkt.pts, src_tb, dst_tb,
						   (AVRounding)(AV_ROUND_NEAR_INF | AV_ROUND_PASS_MINMAX));
		ctx.packet->dts = av_rescale_q_rnd(pkt.dts, src_tb, dst_tb,
						   (AVRounding)(AV_ROUND_NEAR_INF | AV_ROUND_PASS_MINMAX));
		ctx.packet->flags = pkt.keyframe ? AV_PKT_FLAG_KEY : 0;

		ret = av_interleaved_write_frame(ctx.fmt, ctx.packet);
		/* Same as obs-ffmpeg-mux: a single bad packet does not fail the file. */
		if (ret < 0 && ret != AVERROR_INVALIDDATA && ret != AVERROR(EINVAL)) {
			error = "Could not write packet: " + av_error(ret);
			return false;
		}
	}

	ret = av_write_trailer(ctx.fmt);
	if (ret < 0) {
		error = "Could not finish MP4: " + av_error(ret);
		return false;
	}
	avio_flush(ctx.io);
	return true;
}
