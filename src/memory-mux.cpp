/* Writes a replay's encoded packets as an MP4 held in memory, with the index
 * (moov) before the media so a browser can start playing from the first bytes.
 *
 * OBS has already encoded everything, so this only packages it: nothing is
 * decoded or re-encoded. The plugin used to link OBS's own FFmpeg for this,
 * which tied each build to one FFmpeg version: OBS 33 ships FFmpeg 8, and a
 * plugin linked against FFmpeg 7 doesn't load there.
 *
 * Handles what OBS encoders produce: H.264, HEVC and AV1 video, and AAC and
 * Opus audio, one MP4 track per OBS audio track. The layout follows ISO/IEC
 * 14496-12 (ISO BMFF), 14496-14 (esds) and 14496-15 (avcC, hvcC), the AV1
 * ISO BMFF binding (av1C) and the Opus in ISO BMFF spec (dOps). */

#include "replay.hpp"

#include <algorithm>
#include <cstring>
#include <limits>

namespace {

/* ---- Writing boxes ---- */

struct Writer {
	std::vector<uint8_t> &out;

	void u8(uint32_t v) { out.push_back((uint8_t)v); }
	void u16(uint32_t v)
	{
		u8(v >> 8);
		u8(v);
	}
	void u24(uint32_t v)
	{
		u8(v >> 16);
		u16(v);
	}
	void u32(uint32_t v)
	{
		u16(v >> 16);
		u16(v);
	}
	void u64(uint64_t v)
	{
		u32((uint32_t)(v >> 32));
		u32((uint32_t)v);
	}
	void bytes(const uint8_t *data, size_t size) { out.insert(out.end(), data, data + size); }
	void bytes(const std::vector<uint8_t> &data) { bytes(data.data(), data.size()); }
	void zeros(size_t count) { out.insert(out.end(), count, 0); }
	void fourcc(const char *type) { bytes((const uint8_t *)type, 4); }

	/* Starts a box; end() fills in its size once its contents are written. */
	size_t begin(const char *type)
	{
		size_t at = out.size();
		u32(0);
		fourcc(type);
		return at;
	}
	size_t begin_full(const char *type, uint8_t version, uint32_t flags)
	{
		size_t at = begin(type);
		u8(version);
		u24(flags);
		return at;
	}
	void end(size_t at)
	{
		uint32_t size = (uint32_t)(out.size() - at);
		for (int i = 0; i < 4; i++)
			out[at + i] = (uint8_t)(size >> (24 - 8 * i));
	}
};

/* ---- Reading codec headers ---- */

/* Reads bits most significant first; past the end it reads zeros and sets
 * overrun, so a short header is caught once at the end. */
struct Bits {
	const uint8_t *data;
	size_t size;
	size_t pos = 0;
	bool overrun = false;

	uint32_t get(int count)
	{
		uint32_t value = 0;
		for (int i = 0; i < count; i++, pos++) {
			value <<= 1;
			if ((pos >> 3) < size)
				value |= (data[pos >> 3] >> (7 - (pos & 7))) & 1;
			else
				overrun = true;
		}
		return value;
	}

	/* Exp-Golomb, as in H.264 and HEVC headers. */
	uint32_t ue()
	{
		int zeros = 0;
		while (!get(1)) {
			if (overrun || ++zeros > 31)
				return 0;
		}
		return zeros ? (1u << zeros) - 1 + get(zeros) : 0;
	}

	/* AV1's variable length code. */
	uint32_t uvlc()
	{
		int zeros = 0;
		while (!get(1)) {
			if (overrun || ++zeros >= 32)
				return std::numeric_limits<uint32_t>::max();
		}
		return zeros ? (1u << zeros) - 1 + get(zeros) : 0;
	}
};

/* A NAL unit's payload without its emulation prevention bytes (00 00 03). */
std::vector<uint8_t> unescape(const uint8_t *data, size_t size)
{
	std::vector<uint8_t> out;
	out.reserve(size);
	int zeros = 0;
	for (size_t i = 0; i < size; i++) {
		if (zeros >= 2 && data[i] == 3) {
			zeros = 0;
			continue;
		}
		out.push_back(data[i]);
		zeros = data[i] ? 0 : zeros + 1;
	}
	return out;
}

/* A piece of a packet that goes into the file. */
struct Range {
	uint32_t offset, size;
};

/* The NAL units in Annex B data, the form OBS encoders produce: each unit
 * follows a 00 00 01 or 00 00 00 01 start code. */
void annexb_nals(const uint8_t *data, size_t size, std::vector<Range> &nals)
{
	auto start_code = [&](size_t from) {
		for (size_t i = from; i + 3 <= size; i++) {
			if (data[i + 2] > 1) {
				i += 2;
				continue;
			}
			if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1)
				return i;
		}
		return size;
	};

	size_t code = start_code(0);
	while (code < size) {
		size_t begin = code + 3;
		size_t next = start_code(begin);
		size_t end = next;
		/* A NAL unit never ends in a zero byte: those belong to the next
		 * start code, or are trailing padding. */
		while (end > begin && data[end - 1] == 0)
			end--;
		if (end > begin)
			nals.push_back({(uint32_t)begin, (uint32_t)(end - begin)});
		code = next;
	}
}

/* One AV1 OBU: its header byte, where it starts and its total length. */
struct Obu {
	uint8_t type;
	size_t start, size, payload;
};

bool next_obu(const uint8_t *data, size_t size, size_t &pos, Obu &obu)
{
	if (pos >= size || (data[pos] & 0x80))
		return false;
	size_t header = (data[pos] & 0x04) ? 2 : 1;
	bool has_size = data[pos] & 0x02;
	uint64_t length = 0;
	size_t length_bytes = 0;
	if (has_size) {
		for (;; length_bytes++) {
			if (length_bytes == 8 || pos + header + length_bytes >= size)
				return false;
			uint8_t byte = data[pos + header + length_bytes];
			length |= (uint64_t)(byte & 0x7f) << (7 * length_bytes);
			if (!(byte & 0x80)) {
				length_bytes++;
				break;
			}
		}
	} else {
		if (pos + header > size)
			return false;
		length = size - pos - header;
	}
	if (length > size - pos - header - length_bytes)
		return false;
	obu.type = (data[pos] >> 3) & 0x0f;
	obu.start = pos;
	obu.payload = pos + header + length_bytes;
	obu.size = header + length_bytes + (size_t)length;
	pos += obu.size;
	return true;
}

constexpr uint8_t OBU_SEQUENCE_HEADER = 1;
constexpr uint8_t OBU_TEMPORAL_DELIMITER = 2;
constexpr uint8_t OBU_PADDING = 15;

/* ---- Tracks ---- */

enum class Codec { H264, HEVC, AV1, AAC, OPUS };

struct Sample {
	const uint8_t *data;
	uint32_t first_range, ranges;
	uint32_t size; /* bytes in the file */
	int64_t dts, pts;
	uint64_t offset; /* from the start of the media data */
	bool sync;
};

struct Track {
	Codec codec;
	bool video = false;
	const AudioTrack *audio = nullptr;
	uint32_t id = 0;
	uint32_t timescale = 0;
	int64_t default_duration = 0;
	/* H.264 and HEVC: each NAL unit gets a 4-byte length instead of a start
	 * code. Packets already in that form (extradata is an avcC or hvcC
	 * record) are copied as they are. */
	bool to_length_prefixed = false;
	std::vector<uint8_t> config; /* the sample entry box, inside stsd */
	std::vector<Sample> samples;
	std::vector<uint32_t> durations;
	int64_t start = 0;           /* first presentation time, raw */
	uint64_t media_duration = 0; /* track timescale */
	uint64_t shown = 0;          /* presented length, track timescale */
};

/* The parts of a packet that go into the file. */
void split_packet(const Track &track, const uint8_t *data, size_t size, std::vector<Range> &ranges)
{
	if (track.to_length_prefixed) {
		annexb_nals(data, size, ranges);
		return;
	}
	if (track.codec == Codec::AV1) {
		/* Samples carry no temporal delimiters (or padding): the MP4's
		 * sample boundaries already mark temporal units. */
		size_t pos = 0;
		Obu obu;
		while (pos < size) {
			size_t at = pos;
			if (!next_obu(data, size, pos, obu)) {
				ranges.push_back({(uint32_t)at, (uint32_t)(size - at)});
				return;
			}
			if (obu.type != OBU_TEMPORAL_DELIMITER && obu.type != OBU_PADDING)
				ranges.push_back({(uint32_t)obu.start, (uint32_t)obu.size});
		}
		return;
	}
	ranges.push_back({0, (uint32_t)size});
}

/* ---- Sample entries ---- */

void video_entry_start(Writer &w, const VideoTrack &video)
{
	w.zeros(6);
	w.u16(1); /* data_reference_index */
	w.zeros(16);
	w.u16(video.width);
	w.u16(video.height);
	w.u32(0x00480000); /* 72 dpi */
	w.u32(0x00480000);
	w.u32(0);
	w.u16(1); /* frame_count */
	w.zeros(32);
	w.u16(0x0018); /* depth */
	w.u16(0xffff);
}

void write_colr(Writer &w, const VideoTrack &video)
{
	size_t box = w.begin("colr");
	w.fourcc("nclx");
	w.u16(video.color_primaries);
	w.u16(video.color_trc);
	w.u16(video.colorspace);
	w.u8(video.color_range == 2 ? 0x80 : 0);
	w.end(box);
}

/* The parameter sets of one NAL unit type, each once, in order. */
struct ParamSets {
	std::vector<std::vector<uint8_t>> sets[3];

	void add(int which, const uint8_t *data, size_t size)
	{
		std::vector<uint8_t> set(data, data + size);
		if (std::find(sets[which].begin(), sets[which].end(), set) == sets[which].end())
			sets[which].push_back(std::move(set));
	}
};

/* Collects H.264 SPS and PPS (or HEVC VPS, SPS and PPS) from the encoder's
 * header, or from the first keyframe when the header has none. */
ParamSets find_param_sets(const Track &track, const std::vector<uint8_t> &extradata, const std::vector<Range> &ranges)
{
	bool hevc = track.codec == Codec::HEVC;
	ParamSets found;
	auto scan = [&](const uint8_t *data, const Range *nals, size_t count) {
		for (size_t i = 0; i < count; i++) {
			const uint8_t *nal = data + nals[i].offset;
			int type = hevc ? (nal[0] >> 1) & 0x3f : nal[0] & 0x1f;
			int which = hevc ? type - 32 : type == 7 ? 1 : type == 8 ? 2 : -1;
			if (which >= 0 && which <= 2)
				found.add(which, nal, nals[i].size);
		}
	};

	std::vector<Range> header;
	annexb_nals(extradata.data(), extradata.size(), header);
	scan(extradata.data(), header.data(), header.size());
	if (found.sets[1].empty()) {
		for (const Sample &s : track.samples) {
			if (s.sync) {
				scan(s.data, &ranges[s.first_range], s.ranges);
				break;
			}
		}
	}
	return found;
}

bool write_avcc(Writer &w, const ParamSets &ps, std::string &error)
{
	const auto &sps = ps.sets[1];
	const auto &pps = ps.sets[2];
	if (sps.empty() || pps.empty() || sps[0].size() < 4) {
		error = "The H.264 encoder gave no SPS and PPS";
		return false;
	}
	size_t box = w.begin("avcC");
	w.u8(1);
	w.u8(sps[0][1]); /* profile */
	w.u8(sps[0][2]); /* constraint flags */
	w.u8(sps[0][3]); /* level */
	w.u8(0xff);      /* 4-byte NAL lengths */
	w.u8(0xe0 | (uint32_t)std::min<size_t>(sps.size(), 31));
	for (size_t i = 0; i < sps.size() && i < 31; i++) {
		w.u16((uint32_t)sps[i].size());
		w.bytes(sps[i]);
	}
	w.u8((uint32_t)std::min<size_t>(pps.size(), 255));
	for (size_t i = 0; i < pps.size() && i < 255; i++) {
		w.u16((uint32_t)pps[i].size());
		w.bytes(pps[i]);
	}

	/* High profiles also give the chroma format and bit depths. */
	int profile = sps[0][1];
	if (profile == 100 || profile == 110 || profile == 122 || profile == 144) {
		std::vector<uint8_t> rbsp = unescape(sps[0].data() + 1, sps[0].size() - 1);
		Bits b{rbsp.data(), rbsp.size()};
		b.get(24);
		b.ue(); /* seq_parameter_set_id */
		uint32_t chroma = b.ue();
		if (chroma == 3)
			b.get(1);
		uint32_t luma_depth = b.ue();
		uint32_t chroma_depth = b.ue();
		w.u8(0xfc | (chroma & 3));
		w.u8(0xf8 | (luma_depth & 7));
		w.u8(0xf8 | (chroma_depth & 7));
		w.u8(0);
	}
	w.end(box);
	return true;
}

bool write_hvcc(Writer &w, const ParamSets &ps, std::string &error)
{
	if (ps.sets[0].empty() || ps.sets[1].empty() || ps.sets[2].empty() || ps.sets[1][0].size() < 15) {
		error = "The HEVC encoder gave no VPS, SPS and PPS";
		return false;
	}

	/* The SPS after its 2-byte NAL header: the profile, tier and level are
	 * 12 bytes at a fixed place, and the chroma format and bit depths
	 * follow. */
	const std::vector<uint8_t> &sps = ps.sets[1][0];
	std::vector<uint8_t> rbsp = unescape(sps.data() + 2, sps.size() - 2);
	if (rbsp.size() < 13) {
		error = "The HEVC SPS is too short";
		return false;
	}
	Bits b{rbsp.data(), rbsp.size()};
	b.get(4); /* sps_video_parameter_set_id */
	uint32_t sub_layers = b.get(3);
	uint32_t nested = b.get(1);
	b.get(88); /* general profile, tier and level */
	bool profile_present[8] = {false}, level_present[8] = {false};
	for (uint32_t i = 0; i < sub_layers; i++) {
		profile_present[i] = b.get(1);
		level_present[i] = b.get(1);
	}
	if (sub_layers > 0)
		for (uint32_t i = sub_layers; i < 8; i++)
			b.get(2);
	for (uint32_t i = 0; i < sub_layers; i++) {
		if (profile_present[i])
			b.get(88);
		if (level_present[i])
			b.get(8);
	}
	b.ue(); /* sps_seq_parameter_set_id */
	uint32_t chroma = b.ue();
	if (chroma == 3)
		b.get(1);
	b.ue(); /* width */
	b.ue(); /* height */
	if (b.get(1))
		for (int i = 0; i < 4; i++)
			b.ue(); /* conformance window */
	uint32_t luma_depth = b.ue();
	uint32_t chroma_depth = b.ue();

	size_t box = w.begin("hvcC");
	w.u8(1);
	w.bytes(rbsp.data() + 1, 12); /* profile, compatibility, constraints, level */
	w.u16(0xf000);                /* min_spatial_segmentation unknown */
	w.u8(0xfc);                   /* parallelism unknown */
	w.u8(0xfc | (chroma & 3));
	w.u8(0xf8 | (luma_depth & 7));
	w.u8(0xf8 | (chroma_depth & 7));
	w.u16(0); /* average frame rate unknown */
	w.u8(((sub_layers + 1) << 3) | (nested << 2) | 3);
	w.u8(3);
	for (int which = 0; which < 3; which++) {
		w.u8(0x80 | (32 + which)); /* array_completeness: all sets are here */
		w.u16((uint32_t)ps.sets[which].size());
		for (const auto &set : ps.sets[which]) {
			w.u16((uint32_t)set.size());
			w.bytes(set);
		}
	}
	w.end(box);
	return true;
}

/* The av1C fields from an AV1 sequence header OBU (AV1 spec 5.5). */
bool write_av1c_from_sequence_header(Writer &w, const uint8_t *obu, size_t obu_size, size_t payload)
{
	Bits b{obu + payload, obu_size - payload};
	uint32_t profile = b.get(3);
	b.get(1); /* still_picture */
	bool reduced = b.get(1);
	uint32_t level = 0, tier = 0;
	if (reduced) {
		level = b.get(5);
	} else {
		bool decoder_model = false;
		int delay_bits = 0;
		if (b.get(1)) { /* timing_info_present */
			b.get(32);
			b.get(32);
			if (b.get(1))
				b.uvlc();
			decoder_model = b.get(1);
			if (decoder_model) {
				delay_bits = (int)b.get(5) + 1;
				b.get(32);
				b.get(10);
			}
		}
		bool display_delay = b.get(1);
		uint32_t points = b.get(5) + 1;
		for (uint32_t i = 0; i < points; i++) {
			b.get(12);
			uint32_t point_level = b.get(5);
			uint32_t point_tier = point_level > 7 ? b.get(1) : 0;
			if (i == 0) {
				level = point_level;
				tier = point_tier;
			}
			if (decoder_model && b.get(1)) {
				b.get(delay_bits);
				b.get(delay_bits);
				b.get(1);
			}
			if (display_delay && b.get(1))
				b.get(4);
		}
	}
	int width_bits = (int)b.get(4) + 1;
	int height_bits = (int)b.get(4) + 1;
	b.get(width_bits);
	b.get(height_bits);
	if (!reduced && b.get(1)) /* frame_id_numbers_present */
		b.get(7);
	b.get(3); /* 128x128 superblocks, filter intra, intra edge */
	if (!reduced) {
		b.get(4); /* interintra, masked compound, warped motion, dual filter */
		bool order_hint = b.get(1);
		if (order_hint)
			b.get(2);
		uint32_t screen_content = b.get(1) ? 2 : b.get(1);
		if (screen_content > 0 && !b.get(1))
			b.get(1);
		if (order_hint)
			b.get(3);
	}
	b.get(3); /* superres, cdef, restoration */

	bool high_bitdepth = b.get(1);
	bool twelve_bit = profile == 2 && high_bitdepth ? b.get(1) : false;
	bool mono = profile == 1 ? false : b.get(1);
	uint32_t primaries = 2, transfer = 2, matrix = 2;
	if (b.get(1)) {
		primaries = b.get(8);
		transfer = b.get(8);
		matrix = b.get(8);
	}
	uint32_t ss_x = 1, ss_y = 1, sample_position = 0;
	if (mono) {
		b.get(1);
	} else if (primaries == 1 && transfer == 13 && matrix == 0) {
		ss_x = ss_y = 0;
	} else {
		b.get(1); /* color_range */
		if (profile == 1) {
			ss_x = ss_y = 0;
		} else if (profile == 2) {
			if (twelve_bit) {
				ss_x = b.get(1);
				ss_y = ss_x ? b.get(1) : 0;
			} else {
				ss_y = 0;
			}
		}
		if (ss_x && ss_y)
			sample_position = b.get(2);
	}
	if (b.overrun)
		return false;

	size_t box = w.begin("av1C");
	w.u8(0x81); /* marker, version 1 */
	w.u8((profile << 5) | level);
	w.u8((tier << 7) | (high_bitdepth << 6) | (twelve_bit << 5) | (mono << 4) | (ss_x << 3) | (ss_y << 2) |
	     sample_position);
	w.u8(0);
	w.bytes(obu, obu_size);
	w.end(box);
	return true;
}

bool write_av1c(Writer &w, const Track &track, const std::vector<uint8_t> &extradata, const std::vector<Range> &ranges,
		std::string &error)
{
	/* Some encoders give the av1C record itself. */
	if (extradata.size() >= 4 && extradata[0] == 0x81) {
		size_t box = w.begin("av1C");
		w.bytes(extradata);
		w.end(box);
		return true;
	}

	auto find = [&](const uint8_t *data, size_t size) {
		size_t pos = 0;
		Obu obu;
		while (next_obu(data, size, pos, obu))
			if (obu.type == OBU_SEQUENCE_HEADER)
				return write_av1c_from_sequence_header(w, data + obu.start, obu.size,
								       obu.payload - obu.start);
		return false;
	};
	if (find(extradata.data(), extradata.size()))
		return true;
	for (const Sample &s : track.samples) {
		if (!s.sync)
			continue;
		for (uint32_t i = 0; i < s.ranges; i++) {
			const Range &r = ranges[s.first_range + i];
			if (find(s.data + r.offset, r.size))
				return true;
		}
		break;
	}
	error = "The AV1 encoder gave no sequence header";
	return false;
}

/* MPEG-4 descriptors take their length in four 7-bit groups. */
void descriptor(Writer &w, uint8_t tag, size_t length)
{
	w.u8(tag);
	w.u8(0x80 | ((length >> 21) & 0x7f));
	w.u8(0x80 | ((length >> 14) & 0x7f));
	w.u8(0x80 | ((length >> 7) & 0x7f));
	w.u8(length & 0x7f);
}

void write_esds(Writer &w, const Track &track, const std::vector<uint8_t> &config, uint32_t bitrate)
{
	size_t box = w.begin_full("esds", 0, 0);
	size_t decoder_config = 13 + 5 + config.size();
	descriptor(w, 0x03, 3 + 5 + decoder_config + 5 + 1); /* ES_Descriptor */
	w.u16(track.id);
	w.u8(0);
	descriptor(w, 0x04, decoder_config); /* DecoderConfigDescriptor */
	w.u8(0x40);                          /* MPEG-4 audio */
	w.u8(0x15);                          /* audio stream */
	w.u24(0);
	w.u32(bitrate);
	w.u32(bitrate);
	descriptor(w, 0x05, config.size()); /* AudioSpecificConfig */
	w.bytes(config);
	descriptor(w, 0x06, 1); /* SLConfigDescriptor */
	w.u8(0x02);
	w.end(box);
}

/* dOps holds the same fields as Ogg's OpusHead, but big-endian. */
void write_dops(Writer &w, const AudioTrack &audio)
{
	const std::vector<uint8_t> &head = audio.extradata;
	bool valid = head.size() >= 19 && memcmp(head.data(), "OpusHead", 8) == 0;
	uint8_t family = valid ? head[18] : 0;
	uint8_t channels = valid ? head[9] : (uint8_t)audio.channels;
	if (family && head.size() < 21 + (size_t)channels)
		family = 0;
	auto le16 = [&](size_t at) {
		return (uint32_t)(head[at] | head[at + 1] << 8);
	};

	size_t box = w.begin("dOps");
	w.u8(0);
	w.u8(channels);
	w.u16(valid ? le16(10) : 0);                                  /* pre-skip */
	w.u32(valid ? le16(12) | le16(14) << 16 : audio.sample_rate); /* input rate */
	w.u16(valid ? le16(16) : 0);                                  /* output gain */
	w.u8(family);
	if (family)
		w.bytes(head.data() + 19, 2 + channels);
	w.end(box);
}

bool write_sample_entry(Track &track, const Clip &clip, const std::vector<Range> &ranges, std::string &error)
{
	Writer w{track.config};
	if (track.video) {
		const VideoTrack &video = clip.video;
		bool copy = !track.to_length_prefixed && track.codec != Codec::AV1;
		size_t entry = w.begin(track.codec == Codec::H264   ? "avc1"
				       : track.codec == Codec::HEVC ? "hvc1"
								    : "av01");
		video_entry_start(w, video);
		if (copy) {
			/* The encoder gave an avcC or hvcC record: use it as is. */
			size_t box = w.begin(track.codec == Codec::H264 ? "avcC" : "hvcC");
			w.bytes(video.extradata);
			w.end(box);
		} else if (track.codec == Codec::AV1) {
			if (!write_av1c(w, track, video.extradata, ranges, error))
				return false;
		} else {
			ParamSets ps = find_param_sets(track, video.extradata, ranges);
			if (!(track.codec == Codec::H264 ? write_avcc(w, ps, error) : write_hvcc(w, ps, error)))
				return false;
		}
		write_colr(w, video);
		w.end(entry);
		return true;
	}

	const AudioTrack &audio = *track.audio;
	bool opus = track.codec == Codec::OPUS;
	if (!opus && audio.extradata.empty()) {
		error = "The AAC encoder gave no AudioSpecificConfig";
		return false;
	}
	uint32_t channels = opus && audio.extradata.size() >= 19 ? audio.extradata[9] : (uint32_t)audio.channels;
	uint32_t rate = opus ? 48000 : audio.sample_rate;
	size_t entry = w.begin(opus ? "Opus" : "mp4a");
	w.zeros(6);
	w.u16(1); /* data_reference_index */
	w.zeros(8);
	w.u16(channels);
	w.u16(16);
	w.u32(0);
	w.u32(rate <= 0xffff ? rate << 16 : 0);
	if (opus)
		write_dops(w, audio);
	else
		write_esds(w, track, audio.extradata, (uint32_t)std::max<int64_t>(0, audio.bitrate_kbps * 1000));
	w.end(entry);
	return true;
}

/* ---- The index ---- */

constexpr uint32_t MOVIE_TIMESCALE = 1000;

uint64_t to_movie_time(uint64_t value, uint32_t timescale)
{
	return (value * MOVIE_TIMESCALE + timescale / 2) / timescale;
}

const uint32_t MATRIX[9] = {0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000};

void write_stbl(Writer &w, const Track &track, uint64_t base, bool co64)
{
	size_t stbl = w.begin("stbl");

	size_t stsd = w.begin_full("stsd", 0, 0);
	w.u32(1);
	w.bytes(track.config);
	w.end(stsd);

	/* Decode times: runs of equal durations. */
	std::vector<std::pair<uint32_t, uint32_t>> runs;
	for (uint32_t d : track.durations) {
		if (!runs.empty() && runs.back().second == d)
			runs.back().first++;
		else
			runs.push_back({1, d});
	}
	size_t stts = w.begin_full("stts", 0, 0);
	w.u32((uint32_t)runs.size());
	for (const auto &run : runs) {
		w.u32(run.first);
		w.u32(run.second);
	}
	w.end(stts);

	/* Presentation offsets, when B-frames make them differ. */
	runs.clear();
	bool reordered = false;
	for (const Sample &s : track.samples) {
		uint32_t offset = (uint32_t)(s.pts - s.dts);
		reordered |= offset != 0;
		if (!runs.empty() && runs.back().second == offset)
			runs.back().first++;
		else
			runs.push_back({1, offset});
	}
	if (reordered) {
		size_t ctts = w.begin_full("ctts", 0, 0);
		w.u32((uint32_t)runs.size());
		for (const auto &run : runs) {
			w.u32(run.first);
			w.u32(run.second);
		}
		w.end(ctts);
	}

	if (track.video) {
		size_t stss = w.begin_full("stss", 0, 0);
		size_t count_at = w.out.size();
		w.u32(0);
		uint32_t count = 0;
		for (size_t i = 0; i < track.samples.size(); i++) {
			if (track.samples[i].sync) {
				w.u32((uint32_t)i + 1);
				count++;
			}
		}
		for (int i = 0; i < 4; i++)
			w.out[count_at + i] = (uint8_t)(count >> (24 - 8 * i));
		w.end(stss);
	}

	/* One sample per chunk, so each chunk offset is a sample's. */
	size_t stsc = w.begin_full("stsc", 0, 0);
	w.u32(1);
	w.u32(1);
	w.u32(1);
	w.u32(1);
	w.end(stsc);

	size_t stsz = w.begin_full("stsz", 0, 0);
	w.u32(0);
	w.u32((uint32_t)track.samples.size());
	for (const Sample &s : track.samples)
		w.u32(s.size);
	w.end(stsz);

	size_t stco = w.begin_full(co64 ? "co64" : "stco", 0, 0);
	w.u32((uint32_t)track.samples.size());
	for (const Sample &s : track.samples) {
		if (co64)
			w.u64(base + s.offset);
		else
			w.u32((uint32_t)(base + s.offset));
	}
	w.end(stco);

	w.end(stbl);
}

void write_trak(Writer &w, const Track &track, const Clip &clip, uint64_t base, bool co64, bool enabled)
{
	uint64_t empty = to_movie_time(track.start > 0 ? (uint64_t)track.start : 0, track.timescale);
	uint64_t shown = to_movie_time(track.shown, track.timescale);

	size_t trak = w.begin("trak");

	size_t tkhd = w.begin_full("tkhd", 0, enabled ? 3 : 2);
	w.u32(0);
	w.u32(0);
	w.u32(track.id);
	w.u32(0);
	w.u32((uint32_t)(empty + shown));
	w.zeros(8);
	w.u16(0);                        /* layer */
	w.u16(track.video ? 0 : 1);      /* alternate_group: audio tracks are alternatives */
	w.u16(track.video ? 0 : 0x0100); /* volume */
	w.u16(0);
	for (uint32_t m : MATRIX)
		w.u32(m);
	w.u32(track.video ? clip.video.width << 16 : 0);
	w.u32(track.video ? clip.video.height << 16 : 0);
	w.end(tkhd);

	/* Maps the track's timeline to the movie's: playback starts at the first
	 * presented frame, at its time in the replay (B-frames make decoding
	 * start earlier). */
	size_t edts = w.begin("edts");
	size_t elst = w.begin_full("elst", 0, 0);
	w.u32(empty ? 2 : 1);
	if (empty) {
		w.u32((uint32_t)empty);
		w.u32(0xffffffff);
		w.u32(0x00010000);
	}
	w.u32((uint32_t)shown);
	w.u32((uint32_t)(std::max<int64_t>(track.start, 0) - track.samples[0].dts));
	w.u32(0x00010000);
	w.end(elst);
	w.end(edts);

	size_t mdia = w.begin("mdia");
	size_t mdhd = w.begin_full("mdhd", 0, 0);
	w.u32(0);
	w.u32(0);
	w.u32(track.timescale);
	w.u32((uint32_t)track.media_duration);
	w.u16(0x55c4); /* "und" */
	w.u16(0);
	w.end(mdhd);

	size_t hdlr = w.begin_full("hdlr", 0, 0);
	w.u32(0);
	w.fourcc(track.video ? "vide" : "soun");
	w.zeros(12);
	const char *name = track.video ? "VideoHandler" : "SoundHandler";
	w.bytes((const uint8_t *)name, strlen(name) + 1);
	w.end(hdlr);

	size_t minf = w.begin("minf");
	if (track.video) {
		size_t vmhd = w.begin_full("vmhd", 0, 1);
		w.zeros(8);
		w.end(vmhd);
	} else {
		size_t smhd = w.begin_full("smhd", 0, 0);
		w.zeros(4);
		w.end(smhd);
	}
	size_t dinf = w.begin("dinf");
	size_t dref = w.begin_full("dref", 0, 0);
	w.u32(1);
	w.end(w.begin_full("url ", 0, 1)); /* media is in this file */
	w.end(dref);
	w.end(dinf);
	write_stbl(w, track, base, co64);
	w.end(minf);
	w.end(mdia);

	w.end(trak);
}

std::vector<uint8_t> moov_box(const std::vector<Track> &tracks, const Clip &clip, uint64_t base, bool co64)
{
	std::vector<uint8_t> out;
	Writer w{out};

	uint64_t duration = 0;
	for (const Track &t : tracks)
		duration = std::max(duration,
				    to_movie_time((uint64_t)std::max<int64_t>(t.start, 0) + t.shown, t.timescale));

	size_t moov = w.begin("moov");
	size_t mvhd = w.begin_full("mvhd", 0, 0);
	w.u32(0);
	w.u32(0);
	w.u32(MOVIE_TIMESCALE);
	w.u32((uint32_t)duration);
	w.u32(0x00010000); /* rate 1.0 */
	w.u16(0x0100);     /* volume 1.0 */
	w.zeros(10);
	for (uint32_t m : MATRIX)
		w.u32(m);
	w.zeros(24);
	w.u32((uint32_t)tracks.size() + 1); /* next_track_ID */
	w.end(mvhd);

	bool first_audio = true;
	for (const Track &t : tracks) {
		/* Players play the enabled track of each kind: the first audio. */
		write_trak(w, t, clip, base, co64, t.video || first_audio);
		if (!t.video)
			first_audio = false;
	}
	w.end(moov);
	return out;
}

bool codec_of(const std::string &name, Codec &codec)
{
	if (name == "h264")
		codec = Codec::H264;
	else if (name == "hevc")
		codec = Codec::HEVC;
	else if (name == "av1")
		codec = Codec::AV1;
	else if (name == "aac")
		codec = Codec::AAC;
	else if (name == "opus")
		codec = Codec::OPUS;
	else
		return false;
	return true;
}

int64_t rescale(int64_t value, uint32_t from, uint32_t to)
{
	if (from == to)
		return value;
	return (int64_t)((long double)value * to / from + (value >= 0 ? 0.5L : -0.5L));
}

} // namespace

bool mux_clip_to_mp4(const Clip &clip, std::vector<uint8_t> &mp4, std::string &error)
{
	std::vector<Track> tracks;
	tracks.emplace_back();
	Track &video = tracks.back();
	video.video = true;
	if (!codec_of(clip.video.codec, video.codec) || video.codec == Codec::AAC || video.codec == Codec::OPUS) {
		error = "Unsupported video codec: " + clip.video.codec;
		return false;
	}
	const std::vector<uint8_t> &header = clip.video.extradata;
	video.to_length_prefixed = video.codec != Codec::AV1 && !(header.size() >= 7 && header[0] == 1);

	for (const AudioTrack &audio : clip.audio) {
		if (clip.youtube_audio_index >= 0 && audio.track_idx != static_cast<size_t>(clip.youtube_audio_index))
			continue;
		Track t;
		if (!codec_of(audio.codec, t.codec) || (t.codec != Codec::AAC && t.codec != Codec::OPUS)) {
			error = "Unsupported audio codec: " + audio.codec;
			return false;
		}
		t.audio = &audio;
		tracks.push_back(std::move(t));
	}

	/* Samples go into the file in the order OBS gave them, which interleaves
	 * the tracks by time. */
	std::vector<Range> ranges;
	std::vector<std::pair<size_t, size_t>> order;
	uint64_t media_size = 0;
	for (const encoder_packet &pkt : clip.packets) {
		Track *track = nullptr;
		for (Track &t : tracks) {
			if (pkt.type == OBS_ENCODER_VIDEO ? t.video
							  : (t.audio && t.audio->track_idx == pkt.track_idx)) {
				track = &t;
				break;
			}
		}
		if (!track || !pkt.data || !pkt.size || pkt.timebase_den <= 0)
			continue;

		/* OBS timestamps count in units of 1/timebase_den. */
		if (!track->timescale) {
			track->timescale = (uint32_t)pkt.timebase_den;
			track->default_duration = track->video ? pkt.timebase_num : (int64_t)track->audio->frame_size;
		}
		int64_t dts = rescale(pkt.dts, (uint32_t)pkt.timebase_den, track->timescale);
		int64_t pts = rescale(pkt.pts, (uint32_t)pkt.timebase_den, track->timescale);

		/* Like OBS's own muxer, a single bad packet doesn't fail the file. */
		if (pts < dts || (!track->samples.empty() && dts <= track->samples.back().dts))
			continue;

		Sample s{};
		s.data = pkt.data;
		s.dts = dts;
		s.pts = pts;
		s.sync = track->video ? pkt.keyframe : true;
		s.first_range = (uint32_t)ranges.size();
		split_packet(*track, pkt.data, pkt.size, ranges);
		s.ranges = (uint32_t)(ranges.size() - s.first_range);
		uint64_t size = 0;
		for (uint32_t i = 0; i < s.ranges; i++)
			size += ranges[s.first_range + i].size + (track->to_length_prefixed ? 4 : 0);
		if (!size || size > std::numeric_limits<uint32_t>::max()) {
			ranges.resize(s.first_range);
			continue;
		}
		s.size = (uint32_t)size;
		s.offset = media_size;
		media_size += size;
		order.push_back({(size_t)(track - tracks.data()), track->samples.size()});
		track->samples.push_back(s);
	}

	if (tracks[0].samples.empty()) {
		error = "The replay has no video";
		return false;
	}

	/* Timing, and the sample entries. */
	uint32_t next_id = 1;
	for (Track &t : tracks) {
		if (t.samples.empty())
			continue;
		t.id = next_id++;
		size_t count = t.samples.size();
		t.durations.resize(count);
		int64_t end = std::numeric_limits<int64_t>::min();
		t.start = std::numeric_limits<int64_t>::max();
		for (size_t i = 0; i < count; i++) {
			int64_t d = i + 1 < count            ? t.samples[i + 1].dts - t.samples[i].dts
				    : t.default_duration > 0 ? t.default_duration
				    : i > 0                  ? t.durations[i - 1]
							     : 1;
			t.durations[i] = (uint32_t)d;
			t.media_duration += (uint64_t)d;
			t.start = std::min(t.start, t.samples[i].pts);
			end = std::max(end, t.samples[i].pts + d);
		}
		t.shown = (uint64_t)(end - std::max<int64_t>(t.start, 0));
		if (!write_sample_entry(t, clip, ranges, error))
			return false;
	}

	/* Order tracks, dropping audio tracks that got no packets. Samples refer
	 * to tracks by index, so map the old indexes to the new ones. */
	std::vector<size_t> new_index(tracks.size());
	std::vector<Track> kept;
	for (size_t i = 0; i < tracks.size(); i++) {
		new_index[i] = kept.size();
		if (!tracks[i].samples.empty())
			kept.push_back(std::move(tracks[i]));
	}
	tracks = std::move(kept);

	std::vector<uint8_t> ftyp;
	{
		Writer w{ftyp};
		size_t box = w.begin("ftyp");
		w.fourcc("isom");
		w.u32(0x200);
		w.fourcc("isom");
		w.fourcc("iso2");
		if (tracks[0].codec == Codec::H264)
			w.fourcc("avc1");
		if (tracks[0].codec == Codec::AV1)
			w.fourcc("av01");
		w.fourcc("mp41");
		w.end(box);
	}

	/* The index comes first, so the media starts after it: size it once, then
	 * write it with the real offsets. Offsets past 4 GB need co64. */
	bool large = media_size + 8 > std::numeric_limits<uint32_t>::max();
	size_t mdat_header = large ? 16 : 8;
	bool co64 = false;
	std::vector<uint8_t> moov = moov_box(tracks, clip, 0, co64);
	if (ftyp.size() + moov.size() + mdat_header + media_size > std::numeric_limits<uint32_t>::max()) {
		co64 = true;
		moov = moov_box(tracks, clip, 0, co64);
	}
	uint64_t base = ftyp.size() + moov.size() + mdat_header;
	moov = moov_box(tracks, clip, base, co64);

	mp4.clear();
	mp4.reserve((size_t)(base + media_size));
	Writer w{mp4};
	w.bytes(ftyp);
	w.bytes(moov);
	if (large) {
		w.u32(1);
		w.fourcc("mdat");
		w.u64(media_size + 16);
	} else {
		w.u32((uint32_t)(media_size + 8));
		w.fourcc("mdat");
	}
	for (const auto &[old_track, index] : order) {
		const Track &t = tracks[new_index[old_track]];
		const Sample &s = t.samples[index];
		for (uint32_t i = 0; i < s.ranges; i++) {
			const Range &r = ranges[s.first_range + i];
			if (t.to_length_prefixed)
				w.u32(r.size);
			w.bytes(s.data + r.offset, r.size);
		}
	}
	return true;
}
