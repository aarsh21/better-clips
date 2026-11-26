/* Mux and save a local MP4 before uploading it to YouTube. */

#include "replay.hpp"
#include "plugin-support.h"

#include <obs-frontend-api.h>
#include <util/platform.h>
#include <QFile>
#include <QDir>
#include <QDateTime>
#include <QJsonObject>
#include <QJsonDocument>
#include <QSaveFile>
#include <QUuid>
#include <QObject>

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
struct Delivery {
	std::shared_ptr<Clip> clip;
	std::string path; /* nonempty for an approved, disk-backed review */
	YouTubeUpload details;
	qint64 bytes = 0, modified = 0;
};
std::deque<Delivery> queue, to_disk;
size_t buffered_uploads = 0; /* exclude approved jobs: those don't hold MP4s */
size_t reserved = 0;         /* accepted presses not yet handed off by the encoder */
std::atomic<bool> stopping{false};
std::thread worker;
std::thread disk_worker;
QObject *processing = nullptr; /* UI-thread owner of processing timers and requests */

/* Seconds to wait before each retry; the clip only lives in memory, so try
 * for a couple of minutes before giving up. */
constexpr int RETRY_DELAYS[] = {2, 5, 15, 30, 60};

/* Each waiting clip holds its video in memory, so stop taking new ones when
 * uploads fall this far behind instead of running OBS out of memory. */
constexpr size_t UPLOAD_SLOTS = 2;
constexpr size_t DISK_SLOTS = 3;

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
		notify_user("Better Clips: could not build the clip (" + error + ")");
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
	std::vector<encoder_packet>().swap(clip.packets);
	return true;
}

/* Writes the MP4 into OBS's recording folder, named like OBS's own replays
 * ("Replay 2026-11-24 14-35-07_Valorant.mp4") and never over another file.
 * Returns the path, or an empty string if it couldn't. */
std::string write_file(const std::string &dir, std::string file, const std::vector<uint8_t> &mp4)
{
	if (dir.empty())
		return {};

	for (char &c : file)
		if (c == '/')
			c = ' ';
	if (file.size() > 4 && file.compare(file.size() - 4, 4, ".mp4") == 0)
		file.resize(file.size() - 4);
	const std::string base = dir + "/Replay " + file;

	os_mkdirs(dir.c_str());
	for (int n = 1;; n++) {
		const auto path = base + (n == 1 ? "" : "-" + std::to_string(n)) + ".mp4";
		QFile f(QString::fromStdString(path));
		if (!f.open(QIODevice::WriteOnly | QIODevice::NewOnly)) {
			if (f.exists())
				continue;
			return {};
		}
		const auto size = static_cast<qint64>(mp4.size());
		if (f.write(reinterpret_cast<const char *>(mp4.data()), size) == size && f.flush()) {
			f.close();
			if (f.error() == QFileDevice::NoError)
				return path;
		}
		f.remove();
		return {};
	}
}

/* Keeps a clip that couldn't be uploaded, and says where it went. */
std::string save_to_disk(const Clip &clip, const std::vector<uint8_t> &mp4)
{
	auto path = write_file(clip.save_dir, clip.name, mp4);
	if (path.empty()) {
		if (char *dir = obs_module_config_path("recovered-clips")) {
			path = write_file(dir, clip.name, mp4);
			bfree(dir);
		}
	}
	return path;
}

void keep_on_disk(const Clip &clip, const std::vector<uint8_t> &mp4, const std::string &why,
		  const char *log_reason = nullptr)
{
	if (!log_reason)
		log_reason = why.c_str();
	std::string path = save_to_disk(clip, mp4);
	if (path.empty()) {
		obs_log(LOG_ERROR, "%s: %s, and it couldn't be saved to the recording folder", clip.name.c_str(),
			log_reason);
		notify_user("Better Clips: " + why + ", and it couldn't be saved to disk. Clip lost.");
		return;
	}
	obs_log(LOG_INFO, "%s: %s, saved to %s", clip.name.c_str(), log_reason, path.c_str());
	notify_user("Better Clips: " + why + ". Saved it to " + path);
}

QString receipt_dir()
{
	char *dir = obs_module_config_path("processing");
	auto path = QString::fromUtf8(dir);
	bfree(dir);
	return path;
}

/* Only this plugin's private receipts are read. No bearer tokens on disk here;
 * restart uses the current pairing for the same channel, service and route. */
void watch_copy(const YouTubeSettings &settings, const QJsonObject &r, const QString &receipt)
{
	const QString path = r.value("path").toString();
	youtube_watch(processing, settings, r.value("clip").toString().toStdString(),
		      r.value("title").toString().toStdString(), path.toStdString(), [receipt]() {
			      if (!receipt.isEmpty())
				      QFile::remove(receipt);
		      });
}

void track_copy(const Delivery &job, const std::string &id)
{
	const auto &clip = *job.clip;
	const auto &path = job.path;
	const QFileInfo file(QString::fromStdString(path));
	QJsonObject r{{"clip", QString::fromStdString(id)},
		      {"title", QString::fromStdString(job.details.title)},
		      {"path", file.absoluteFilePath()},
		      {"channel", QString::fromStdString(clip.youtube.channel_id)},
		      {"app", QString::fromStdString(clip.youtube.app_url)},
		      {"direct", clip.youtube.route == YouTubeRoute::Direct}};
	const auto dir = receipt_dir();
	QString receipt;
	if (!dir.isEmpty() && QDir().mkpath(dir)) {
		QSaveFile out(QDir(dir).filePath(QUuid::createUuid().toString(QUuid::WithoutBraces) + ".json"));
		const auto bytes = QJsonDocument(r).toJson();
		if (out.open(QIODevice::WriteOnly) && out.write(bytes) == bytes.size() && out.commit())
			receipt = out.fileName();
	}
	if (receipt.isEmpty())
		obs_log(LOG_WARNING, "Cannot resume processing check after OBS exits. Local copy: %s", path.c_str());
	watch_copy(clip.youtube, r, receipt);
}

void resume_watches()
{
	const auto dir = receipt_dir();
	if (dir.isEmpty())
		return;
	const auto settings = get_youtube_settings();
	const bool direct = settings.route == YouTubeRoute::Direct;
	for (const auto &file : QDir(dir).entryInfoList({"*.json"}, QDir::Files)) {
		QFile in(file.absoluteFilePath());
		if (!in.open(QIODevice::ReadOnly))
			continue;
		const auto r = QJsonDocument::fromJson(in.readAll()).object();
		if (r.value("direct").toBool() == direct &&
		    r.value("channel").toString().toStdString() == settings.channel_id &&
		    (direct ? !settings.refresh_token.empty()
			    : !settings.upload_token.empty() &&
				      r.value("app").toString().toStdString() == settings.app_url))
			watch_copy(settings, r, file.absoluteFilePath());
	}
}

void upload_clip(Delivery job)
{
	Clip &clip = *job.clip;
	std::vector<uint8_t> mp4;
	std::string error;
	if (!job.path.empty()) {
		if (stopping)
			return; /* Already safe on disk. */
		QFile in(QString::fromStdString(job.path));
		if (in.open(QIODevice::ReadOnly) && in.size() == job.bytes &&
		    QFileInfo(in).lastModified().toMSecsSinceEpoch() == job.modified) {
			mp4.resize(static_cast<size_t>(job.bytes));
			if (in.read(reinterpret_cast<char *>(mp4.data()), static_cast<qint64>(mp4.size())) !=
			    static_cast<qint64>(mp4.size()))
				mp4.clear();
		}
		if (mp4.empty()) {
			notify_user("Better Clips: the reviewed file changed or could not be read. Upload skipped: " +
				    job.path);
			return;
		}
	} else if (!build(clip, mp4))
		return;
	if (stopping) {
		if (job.path.empty())
			keep_on_disk(clip, mp4, "OBS is closing");
		return;
	}

	auto &details = job.details;
	YouTubeSession session;
	auto &recovery = job.path;
	if (recovery.empty()) {
		if (clip.youtube_audio_index < 0) {
			keep_on_disk(clip, mp4, "the selected YouTube audio track is not in the Replay Buffer");
			return;
		}
		details = {youtube_title(clip.youtube.title_template, clip.game, clip.recorded_at),
			   clip.youtube.description, clip.youtube.privacy};
		recovery = save_to_disk(clip, mp4);
		if (recovery.empty()) {
			notify_user(
				"Better Clips: couldn't save a YouTube recovery copy in the recording or plugin folder. Clip lost; check disk space and permissions.");
			return;
		}
		job.bytes = static_cast<qint64>(mp4.size());
		job.modified = QFileInfo(QString::fromStdString(recovery)).lastModified().toMSecsSinceEpoch();
		if (clip.youtube.review_before_upload) {
			notify_user("Better Clips: review the upload in OBS. A copy is kept at " + recovery);
			QMetaObject::invokeMethod(
				processing,
				[job] {
					youtube_review(job.details, job.clip->youtube.channel_title, job.path,
						       [job](YouTubeUpload edits) mutable {
							       std::lock_guard<std::mutex> lock(mutex);
							       if (!stopping) {
								       job.details = std::move(edits);
								       queue.push_back(std::move(job));
								       wake.notify_all();
							       }
						       });
				},
				Qt::QueuedConnection);
			return;
		}
	}
	notify_user("Better Clips: uploading " + clip.name + " (" + format_mb(mp4.size()) + ")...");

	for (size_t attempt = 0;; attempt++) {
		auto upload_start = std::chrono::steady_clock::now();
		std::string link;
		if (stopping) {
			error = "OBS is closing";
			break;
		}
		if (youtube_upload(clip, details, mp4, session, link, error, stopping, processing)) {
			record_upload_success();
			auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
					  std::chrono::steady_clock::now() - upload_start)
					  .count();
			obs_log(LOG_INFO, "Uploaded %s (%zu bytes) in %lld ms", clip.name.c_str(), mp4.size(),
				(long long)ms);

			notify_user("Better Clips: uploaded, link copied: " + link + ". Local copy: " + recovery, link);
			track_copy(job, session.clip_id);
			return;
		}

		std::unique_lock<std::mutex> lock(mutex);
		if (attempt >= std::size(RETRY_DELAYS) || stopping || session.permanent_failure)
			break;
		notify_user("Better Clips: upload failed (" + error + "), retrying in " +
			    std::to_string(RETRY_DELAYS[attempt]) + "s");
		wake.wait_for(lock, std::chrono::seconds(RETRY_DELAYS[attempt]), [] { return stopping.load(); });
	}

	notify_user("Better Clips: YouTube upload failed (" + error + "). Local copy: " + recovery);
}

void write_clip(Delivery job)
{
	Clip &clip = *job.clip;
	std::vector<uint8_t> mp4;
	if (build(clip, mp4))
		keep_on_disk(clip, mp4, "still uploading earlier clips");
}

/* Handles clips from one queue until OBS closes and the queue is empty. */
void run(std::deque<Delivery> &clips, void (*handle)(Delivery))
{
	for (;;) {
		Delivery job;
		{
			std::unique_lock<std::mutex> lock(mutex);
			wake.wait(lock, [&] { return stopping || !clips.empty(); });
			if (clips.empty())
				return; /* stopping and nothing left */
			job = std::move(clips.front());
			clips.pop_front();
			if (&clips == &queue && job.path.empty())
				--buffered_uploads;
		}
		handle(std::move(job));
	}
}

} // namespace

void uploader_start()
{
	processing = new QObject;
	resume_watches();
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
			obs_log(LOG_INFO, "Saving %zu queued upload(s) to disk before exit", queue.size());
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
	{
		std::lock_guard<std::mutex> lock(mutex);
		--reserved;
		if (buffered_uploads < UPLOAD_SLOTS) {
			obs_log(LOG_INFO, "Saved replay %s from memory (%zu packets)", clip->name.c_str(),
				clip->packets.size());
			queue.push_back({std::shared_ptr<Clip>(clip), {}, {}});
			++buffered_uploads;
		} else {
			/* Uploads are stuck behind a slow or broken connection: write
			 * this one to disk now rather than hold it in memory. */
			obs_log(LOG_WARNING, "%zu clips are still waiting to upload; saving %s to disk", queue.size(),
				clip->name.c_str());
			to_disk.push_back({std::shared_ptr<Clip>(clip), {}, {}});
		}
	}
	wake.notify_all();
}

bool uploader_reserve()
{
	std::lock_guard<std::mutex> lock(mutex);
	if (stopping || buffered_uploads + to_disk.size() + reserved >= UPLOAD_SLOTS + DISK_SLOTS)
		return false;
	++reserved;
	return true;
}

void uploader_cancel_reservation()
{
	std::lock_guard<std::mutex> lock(mutex);
	--reserved;
}
