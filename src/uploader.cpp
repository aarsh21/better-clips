/* Background thread that turns saved clips into MP4s in memory and uploads
 * them. Nothing here touches the disk. */

#include "replay-r2.hpp"
#include "plugin-support.h"

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <iterator>
#include <memory>
#include <mutex>
#include <thread>

namespace {

std::mutex mutex;
std::condition_variable wake;
std::deque<std::unique_ptr<Clip>> queue;
bool stopping = false;
std::thread worker;

/* Seconds to wait before each retry; the clip only lives in memory, so try
 * for a couple of minutes before giving up. */
constexpr int RETRY_DELAYS[] = {2, 5, 15, 30, 60};

std::string format_mb(size_t bytes)
{
	char buf[32];
	snprintf(buf, sizeof(buf), "%.1f MB", (double)bytes / (1024.0 * 1024.0));
	return buf;
}

void upload_clip(const Clip &clip)
{
	std::vector<uint8_t> mp4;
	std::string error;

	auto mux_start = std::chrono::steady_clock::now();
	if (!mux_clip_to_mp4(clip, mp4, error)) {
		obs_log(LOG_ERROR, "Could not build %s: %s", clip.name.c_str(), error.c_str());
		notify_user("Replay to R2: could not build the clip (" + error + ")");
		return;
	}
	auto mux_ms =
		std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - mux_start)
			.count();
	obs_log(LOG_INFO, "Built %s in memory: %zu bytes, %zu packets, %lld ms", clip.name.c_str(), mp4.size(),
		clip.packets.size(), (long long)mux_ms);

	const std::string key = object_key(clip.config, clip.name);
	notify_user("Replay to R2: uploading " + clip.name + " (" + format_mb(mp4.size()) + ")...");

	for (size_t attempt = 0;; attempt++) {
		auto upload_start = std::chrono::steady_clock::now();
		if (s3_put_object(clip.config, key, mp4, "video/mp4", error)) {
			auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
					  std::chrono::steady_clock::now() - upload_start)
					  .count();
			obs_log(LOG_INFO, "Uploaded %s (%zu bytes) in %lld ms", key.c_str(), mp4.size(), (long long)ms);

			std::string link;
			if (!clip.config.public_url.empty()) {
				link = clip.config.public_url;
				while (!link.empty() && link.back() == '/')
					link.pop_back();
				link += "/" + key;
			}
			notify_user(link.empty() ? "Replay to R2: uploaded " + key
						 : "Replay to R2: uploaded, link copied: " + link,
				    link);
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

	obs_log(LOG_ERROR, "Giving up on %s: %s", key.c_str(), error.c_str());
	notify_user("Replay to R2: upload failed, clip lost (" + error + ")");
}

void run()
{
	for (;;) {
		std::unique_ptr<Clip> clip;
		{
			std::unique_lock<std::mutex> lock(mutex);
			wake.wait(lock, [] { return stopping || !queue.empty(); });
			if (queue.empty())
				return; /* stopping and nothing left */
			clip = std::move(queue.front());
			queue.pop_front();
		}
		upload_clip(*clip);
	}
}

} // namespace

void uploader_start()
{
	stopping = false;
	worker = std::thread(run);
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
}

void uploader_enqueue(Clip *clip)
{
	obs_log(LOG_INFO, "Saved replay %s from memory (%zu packets)", clip->name.c_str(), clip->packets.size());
	{
		std::lock_guard<std::mutex> lock(mutex);
		queue.emplace_back(clip);
	}
	wake.notify_one();
}
