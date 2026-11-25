/* Background threads that turn saved clips into MP4s in memory and upload
 * them. A clip only touches the disk when it can't be uploaded: then it's
 * saved to OBS's recording folder instead of being lost. */

#include "replay-r2.hpp"
#include "plugin-support.h"

#include <obs-frontend-api.h>
#include <util/platform.h>
#include <QNetworkAccessManager>

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <functional>
#include <iterator>
#include <memory>
#include <mutex>
#include <thread>

namespace {

std::mutex mutex;
std::condition_variable wake;
std::deque<std::unique_ptr<Clip>> queue;   /* waiting to upload */
std::deque<std::unique_ptr<Clip>> to_disk; /* arrived while the uploads were full */
bool stopping = false;
std::thread worker;
std::thread disk_worker;
QNetworkAccessManager *processing = nullptr; /* UI event loop; only asynchronous requests */

/* Seconds to wait before each retry; the clip only lives in memory, so try
 * for a couple of minutes before giving up. */
constexpr int RETRY_DELAYS[] = {2, 5, 15, 30, 60};

/* Each waiting clip holds its video in memory, so stop taking new ones when
 * uploads fall this far behind instead of running OBS out of memory. */
constexpr size_t MAX_QUEUED = 3;

std::string format_mb(size_t bytes)
{
	char buf[32];
	snprintf(buf, sizeof(buf), "%.1f MB", (double)bytes / (1024.0 * 1024.0));
	return buf;
}

/* Writes the clip as an MP4 and frees its buffered packets. */
bool build(Clip &clip, std::vector<uint8_t> &mp4)
{
	std::string error;
	auto mux_start = std::chrono::steady_clock::now();
	if (!mux_clip_to_mp4(clip, mp4, error)) {
		obs_log(LOG_ERROR, "Could not build %s: %s", clip.name.c_str(), error.c_str());
		notify_user("Replay to R2: could not build the clip (" + error + ")");
		return false;
	}
	auto mux_ms =
		std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - mux_start)
			.count();
	obs_log(LOG_INFO, "Built %s in memory: %zu bytes, %zu packets, %lld ms", clip.name.c_str(), mp4.size(),
		clip.packets.size(), (long long)mux_ms);

	/* The MP4 has everything now; free the buffered packets. */
	for (encoder_packet &pkt : clip.packets)
		obs_encoder_packet_release(&pkt);
	clip.packets.clear();
	return true;
}

/* Writes the MP4 into OBS's recording folder, named like OBS's own replays
 * ("Replay 2026-11-24 14-35-07_Valorant.mp4") and never over another file.
 * Returns the path, or an empty string if it couldn't. */
std::string save_to_disk(const Clip &clip, const std::vector<uint8_t> &mp4)
{
	if (clip.save_dir.empty())
		return {};

	std::string file = clip.name;
	for (char &c : file)
		if (c == '/')
			c = ' ';
	if (file.size() > 4 && file.compare(file.size() - 4, 4, ".mp4") == 0)
		file.resize(file.size() - 4);
	const std::string base = clip.save_dir + "/Replay " + file;

	std::string path = base + ".mp4";
	for (int n = 2; os_file_exists(path.c_str()); n++)
		path = base + "-" + std::to_string(n) + ".mp4";

	os_mkdirs(clip.save_dir.c_str());
	FILE *f = os_fopen(path.c_str(), "wb");
	if (!f)
		return {};
	bool ok = fwrite(mp4.data(), 1, mp4.size(), f) == mp4.size();
	ok = fclose(f) == 0 && ok;
	if (!ok) {
		os_unlink(path.c_str());
		return {};
	}
	return path;
}

/* Keeps a clip that couldn't be uploaded, and says where it went. */
void keep_on_disk(const Clip &clip, const std::vector<uint8_t> &mp4, const std::string &why)
{
	std::string path = save_to_disk(clip, mp4);
	if (path.empty()) {
		obs_log(LOG_ERROR, "%s: %s, and it couldn't be saved to the recording folder", clip.name.c_str(),
			why.c_str());
		notify_user("Replay to R2: " + why + ", and it couldn't be saved to disk. Clip lost.");
		return;
	}
	obs_log(LOG_INFO, "%s: %s, saved to %s", clip.name.c_str(), why.c_str(), path.c_str());
	notify_user("Replay to R2: " + why + ". Saved it to " + path);
}

void upload_clip(Clip &clip)
{
	std::vector<uint8_t> mp4;
	std::string error;
	if (!build(clip, mp4))
		return;

	const bool yt = clip.youtube.destination == Destination::YouTube;
	YouTubeUpload details;
	YouTubeSession session;
	if (yt) {
		if (clip.youtube_audio_index < 0) {
			keep_on_disk(clip, mp4, "the selected YouTube audio track is not in the Replay Buffer");
			return;
		}
		details = {youtube_title(clip.youtube.title_template, clip.game, clip.recorded_at),
			   clip.youtube.description, clip.youtube.privacy};
		if (clip.youtube.review_before_upload && !youtube_review(details, clip.youtube.channel_title)) {
			keep_on_disk(clip, mp4, "YouTube upload cancelled");
			return;
		}
	}
	const bool via_app = clip.youtube.destination == Destination::ClipsApp;
	std::string key = via_app ? clip.name : object_key(clip.config, clip.name);
	notify_user("Replay to R2: uploading " + clip.name + " (" + format_mb(mp4.size()) + ")...");

	for (size_t attempt = 0;; attempt++) {
		auto upload_start = std::chrono::steady_clock::now();
		std::string link;
		bool uploaded = yt        ? youtube_upload(clip, details, mp4, session, link, error)
				: via_app ? app_upload(clip.config, clip.name, mp4, key, error)
					  : s3_put_object(clip.config, key, mp4, "video/mp4", error);
		if (uploaded) {
			auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
					  std::chrono::steady_clock::now() - upload_start)
					  .count();
			obs_log(LOG_INFO, "Uploaded %s (%zu bytes) in %lld ms", key.c_str(), mp4.size(), (long long)ms);

			if (!yt && !clip.config.public_url.empty()) {
				link = clip.config.public_url;
				while (!link.empty() && link.back() == '/')
					link.pop_back();
				link += "/" + key;
			}
			notify_user(link.empty() ? "Replay to R2: uploaded " + key
						 : "Replay to R2: uploaded, link copied: " + link,
				    link);
			if (yt)
				youtube_watch(processing, clip.youtube, session.clip_id, details.title);
			return;
		}

		obs_log(LOG_WARNING, "Upload of %s failed (attempt %zu): %s", key.c_str(), attempt + 1, error.c_str());

		std::unique_lock<std::mutex> lock(mutex);
		if (attempt >= std::size(RETRY_DELAYS) || stopping)
			break;
		notify_user("Replay to R2: upload failed (" + error + "), retrying in " +
			    std::to_string(RETRY_DELAYS[attempt]) + "s");
		wake.wait_for(lock, std::chrono::seconds(RETRY_DELAYS[attempt]), [] { return stopping; });
	}

	obs_log(LOG_ERROR, "Giving up on uploading %s: %s", key.c_str(), error.c_str());
	keep_on_disk(clip, mp4, "upload failed (" + error + ")");
}

void write_clip(Clip &clip)
{
	std::vector<uint8_t> mp4;
	if (build(clip, mp4))
		keep_on_disk(clip, mp4, "still uploading earlier clips");
}

/* Handles clips from one queue until OBS closes and the queue is empty. */
void run(std::deque<std::unique_ptr<Clip>> &clips, void (*handle)(Clip &))
{
	for (;;) {
		std::unique_ptr<Clip> clip;
		{
			std::unique_lock<std::mutex> lock(mutex);
			wake.wait(lock, [&] { return stopping || !clips.empty(); });
			if (clips.empty())
				return; /* stopping and nothing left */
			clip = std::move(clips.front());
			clips.pop_front();
		}
		handle(*clip);
	}
}

} // namespace

void uploader_start()
{
	processing = new QNetworkAccessManager;
	stopping = false;
	worker = std::thread(run, std::ref(queue), upload_clip);
	disk_worker = std::thread(run, std::ref(to_disk), write_clip);
}

void uploader_stop()
{
	{
		std::lock_guard<std::mutex> lock(mutex);
		stopping = true;
		if (!queue.empty())
			obs_log(LOG_INFO, "Finishing %zu queued upload(s) before exit", queue.size());
	}
	wake.notify_all();
	if (worker.joinable())
		worker.join();
	if (disk_worker.joinable())
		disk_worker.join();
	/* No uploader can queue another watch. Destroy pending timers and requests. */
	delete processing;
	processing = nullptr;
}

void uploader_enqueue(Clip *clip)
{
	/* Read now, so a failed upload lands where this profile records. */
	if (char *dir = obs_frontend_get_current_record_output_path()) {
		clip->save_dir = dir;
		bfree(dir);
	}
	{
		std::lock_guard<std::mutex> lock(mutex);
		if (queue.size() < MAX_QUEUED) {
			obs_log(LOG_INFO, "Saved replay %s from memory (%zu packets)", clip->name.c_str(),
				clip->packets.size());
			queue.emplace_back(clip);
		} else if (to_disk.size() < MAX_QUEUED) {
			/* Uploads are stuck behind a slow or broken connection: write
			 * this one to disk now rather than hold it in memory. */
			obs_log(LOG_WARNING, "%zu clips are still waiting to upload; saving %s to disk", queue.size(),
				clip->name.c_str());
			to_disk.emplace_back(clip);
		} else {
			obs_log(LOG_WARNING, "Dropped %s: uploads and disk writes are both behind", clip->name.c_str());
			notify_user("Replay to R2: still saving earlier clips, this one was not saved");
			delete clip;
			return;
		}
	}
	wake.notify_all();
}
