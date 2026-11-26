#include "replay.hpp"
#include "youtube-google.hpp"

#include <QDateTime>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTimer>
#include <QUrlQuery>

namespace {
QString text(const std::string &s)
{
	return QString::fromStdString(s);
}

using namespace youtube_http;

bool rejected_refresh(const Reply &reply)
{
	return reply.code == CURLE_OK && reply.status / 100 == 4 && reply.json.value("error") == "invalid_grant";
}

Request request(const QUrl &url, const QByteArray &bearer, const QByteArray &range, const QByteArray &body,
		qint64 upload_size = -1)
{
	const bool put = !range.isEmpty();
	Request req{url,
		    put ? "PUT" : "POST",
		    {put ? "Content-Type: video/mp4" : "Content-Type: application/json"},
		    body,
		    60};
	if (!bearer.isEmpty())
		req.headers.append("Authorization: Bearer " + bearer);
	if (upload_size >= 0) {
		req.headers.append("X-Upload-Content-Length: " + QByteArray::number(upload_size));
		req.headers.append("X-Upload-Content-Type: video/mp4");
	}
	if (put)
		req.headers.append("Content-Range: " + range);
	return req;
}
} // namespace

std::string youtube_title(const std::string &title_template, const std::string &game, time_t when)
{
	const auto date = QDateTime::fromSecsSinceEpoch(when);
	QString s = text(title_template)
			    .replace("{date}", date.toString("yyyy-MM-dd"))
			    .replace("{time}", date.toString("HH:mm"))
			    .replace("{game}", game.empty() ? QStringLiteral("Replay") : text(game))
			    .remove('<')
			    .remove('>')
			    .trimmed();
	return s.isEmpty() ? "Replay" : QString::fromStdU32String(s.toStdU32String().substr(0, 100)).toStdString();
}

bool youtube_upload(const Clip &clip, const YouTubeUpload &details, const std::vector<uint8_t> &mp4,
		    YouTubeSession &session, std::string &link, std::string &error, const std::atomic<bool> &stopping)
{
	return youtube_upload(clip, details, mp4, session, link, error, stopping, nullptr);
}

bool youtube_upload(const Clip &clip, const YouTubeUpload &details, const std::vector<uint8_t> &mp4,
		    YouTubeSession &session, std::string &link, std::string &error, const std::atomic<bool> &stopping,
		    QObject *owner)
{
	std::string diagnostic;
	auto transfer = [&](const Request &req) {
		auto r = perform(req, stopping);
		diagnostic = r.diagnostic();
		if (r.code != CURLE_OK && (r.status / 100 == 2 || r.status == 308))
			r.status = 0; // Incomplete response, even if its headers arrived.
		return r;
	};
	auto fail = [&](const std::string &message) {
		// Server messages are useful in the UI, but can contain credentials.
		blog(LOG_WARNING, "[better-clips] YouTube upload failed (%s)", diagnostic.c_str());
		error = message;
		return false;
	};
	auto queue_unpaired = [&](const std::string &token) {
		if (owner)
			QMetaObject::invokeMethod(
				owner, [route = clip.youtube.route, token] { unpaired(route, token); },
				Qt::QueuedConnection);
	};
	const bool direct = clip.youtube.route == YouTubeRoute::Direct;
	QByteArray bearer;
	auto google_request = [&](QUrl url, const QByteArray &range, const QByteArray &body, qint64 size = -1) {
		for (int attempt = 0;; ++attempt) {
			if (bearer.isEmpty()) {
				auto token = transfer(google::refresh(clip.youtube.refresh_token));
				if (rejected_refresh(token))
					queue_unpaired(clip.youtube.refresh_token);
				if (token.status / 100 != 2)
					return token;
				bearer = token.json.value("access_token").toString().toUtf8();
				if (bearer.isEmpty()) {
					fail("Google did not return an access token.");
					return Reply{};
				}
			}
			auto reply = transfer(request(url, bearer, range, body, size));
			if (reply.status != 401 || attempt != 0)
				return reply;
			bearer.clear();
		}
	};
	auto failed = [&](const Reply &reply) {
		const auto status = reply.status;
		auto reason = reply.json.value("error")
				      .toObject()
				      .value("errors")
				      .toArray()
				      .at(0)
				      .toObject()
				      .value("reason")
				      .toString();
		session.permanent_failure =
			permanent_http_error(status) &&
			!(status == 403 && (reason == "rateLimitExceeded" || reason == "userRateLimitExceeded"));
		if (status / 100 != 2 && error.empty()) {
			auto message = reply.json.value("error");
			auto detail = message.toString(message.toObject().value("message").toString(reason));
			fail(message == "invalid_grant" ? "YouTube access expired. Sign in again."
			     : detail.isEmpty()         ? "YouTube upload failed (" + diagnostic + ")"
							: detail.toStdString());
		}
		return status / 100 != 2;
	};
	auto app = [&](const char *path, QJsonObject data) {
		auto reply = transfer(request(QUrl(text(clip.youtube.app_url)).resolved(QUrl(path)),
					      QByteArray::fromStdString(clip.youtube.upload_token), {},
					      QJsonDocument(data).toJson(QJsonDocument::Compact)));
		if (reply.status == 401 && reply.code == CURLE_OK)
			queue_unpaired(clip.youtube.upload_token);
		return reply;
	};
	error.clear();
	bool query = !session.url.empty();
	if (!query && direct) {
		const auto api = google::api("/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status");
		QJsonObject meta{{"snippet", QJsonObject{{"title", text(details.title)},
							 {"description", text(details.description)},
							 {"categoryId", "20"}}},
				 {"status", QJsonObject{{"privacyStatus", text(details.privacy)},
							{"selfDeclaredMadeForKids", clip.youtube.made_for_kids}}}};
		auto r = google_request(api, {}, QJsonDocument(meta).toJson(), static_cast<qint64>(mp4.size()));
		if (failed(r))
			return false;
		auto location = QUrl::fromEncoded(r.location);
		if (location.scheme() != api.scheme() || location.authority() != api.authority()) {
			session.permanent_failure = true;
			return fail("Google returned an unexpected upload address.");
		}
		session.url = location.toEncoded().toStdString();
	} else if (!query) {
		auto r = app("/api/youtube/upload/start",
			     {{"title", text(details.title)},
			      {"description", text(details.description)},
			      {"privacy", text(details.privacy)},
			      {"madeForKids", clip.youtube.made_for_kids},
			      {"size", static_cast<qint64>(mp4.size())},
			      {"category", text(clip.game)},
			      {"recordedAt",
			       QDateTime::fromSecsSinceEpoch(clip.recorded_at).toUTC().toString(Qt::ISODate)}});
		if (failed(r))
			return false;
		session.url = r.json.value("sessionUrl").toString().toStdString();
		session.clip_id = r.json.value("clipId").toString().toStdString();
	}
	if (session.url.empty() || (!direct && session.clip_id.empty())) {
		return fail("The Better Clips app did not open a YouTube upload.");
	}
	const qint64 total = static_cast<qint64>(mp4.size());
	qint64 offset = 0;
	while (session.video_id.empty()) {
		const qint64 n = query ? 0 : std::min<qint64>(8 * 1024 * 1024, total - offset);
		const QByteArray range =
			(query ? QByteArray("bytes *")
			       : "bytes " + QByteArray::number(offset) + "-" + QByteArray::number(offset + n - 1)) +
			"/" + QByteArray::number(total);
		auto bytes = QByteArray::fromRawData(reinterpret_cast<const char *>(mp4.data() + offset), n);
		auto url = QUrl(text(session.url));
		auto r = direct ? google_request(url, range, bytes) : transfer(request(url, {}, range, bytes));
		if (r.status == 404 || r.status == 410) {
			session = {}; // Explicitly expired; no video ID has been confirmed.
			return fail("The YouTube upload session expired.");
		}
		if (r.status != 308 && failed(r))
			return false;
		if (r.status == 308) {
			bool ok = false;
			qint64 last = r.range.mid(8).toLongLong(&ok);
			if (!r.range.isEmpty() &&
			    (!r.range.startsWith("bytes=0-") || !ok || last < 0 || last >= total - 1)) {
				return fail("YouTube reported an unexpected upload position.");
			}
			qint64 next = r.range.isEmpty() ? 0 : last + 1;
			if (!query && next <= offset) {
				return fail("YouTube has not received this part yet.");
			}
			offset = next;
			query = false;
			continue;
		}
		session.video_id = r.json.value("id").toString().toStdString();
		if (session.video_id.empty()) {
			return fail("Waiting for YouTube to confirm the upload.");
		}
	}
	if (direct) {
		session.clip_id = session.video_id;
		link = "https://youtu.be/" + session.video_id;
		return true;
	}
	auto r = app("/api/youtube/upload/complete",
		     {{"videoId", text(session.video_id)}, {"clipId", text(session.clip_id)}});
	if (failed(r))
		return false;
	link = r.json.value("url").toString().toStdString();
	if (link != "https://youtu.be/" + session.video_id) {
		return fail("The Better Clips app did not confirm the video link.");
	}
	return true;
}

/* Schedule lightweight checks on Qt's event loop, with no retained clip data
 * or sleeping upload thread. The uploader owns network for its whole life. */
void youtube_watch(QObject *owner, const YouTubeSettings &settings, const std::string &clip_id,
		   const std::string &title)
{
	youtube_watch(owner, settings, clip_id, title, {}, {});
}

void youtube_watch(QObject *owner, const YouTubeSettings &settings, const std::string &clip_id,
		   const std::string &title, const std::string &path, std::function<void()> finish)
{
	const std::string kept = path.empty() ? ". Check the video in YouTube Studio." : ". Local copy: " + path;
	QUrl url = QUrl(text(settings.app_url)).resolved(QUrl("/api/youtube/upload/status"));
	url.setQuery(QUrlQuery({{"clipId", text(clip_id)}}));
	const bool direct = settings.route == YouTubeRoute::Direct;
	if (direct) {
		url = google::api("/youtube/v3/videos");
		url.setQuery(QUrlQuery({{"part", "status"}, {"id", text(clip_id)}}));
	}
	QMetaObject::invokeMethod(
		owner,
		[owner, url, title, kept, finish, direct, token = settings.upload_token,
		 refresh = settings.refresh_token] {
			auto *timer = new QTimer(owner);
			timer->setSingleShot(true);
			auto access =
				std::make_shared<QByteArray>(direct ? QByteArray() : QByteArray::fromStdString(token));
			auto poll = [=] {
				send(timer, {url, "GET", {"Authorization: Bearer " + *access}}, [=](const Reply &reply) {
					auto obj = reply.json;
					auto status = obj.value("status").toString();
					if (direct) {
						auto state = obj.value("items")
								     .toArray()
								     .at(0)
								     .toObject()
								     .value("status")
								     .toObject()
								     .value("uploadStatus")
								     .toString();
						if (state == "processed")
							status = "ready";
						else if (state == "failed" || state == "rejected" || state == "deleted")
							status = "failed";
					}
					const auto http = reply.code == CURLE_OK ? reply.status : 0;
					if (!direct && http == 401)
						unpaired(YouTubeRoute::ClipsApp, token);
					if (http == 200 && status == "ready") {
						if (finish)
							finish();
						notify_user("YouTube: " + title + " is ready to play" + kept);
					} else if (http == 200 && status == "failed") {
						if (finish)
							finish();
						notify_user("YouTube could not process " + title + kept);
					} else if ((!direct && http == 401) || http == 404)
						notify_user("Clips can no longer check " + title + kept);
					else {
						if (direct && http == 401)
							access->clear();
						timer->start(std::min(timer->interval() * 2, 600000));
						return;
					}
					timer->deleteLater();
				});
			};
			QObject::connect(timer, &QTimer::timeout, timer, [=] {
				if (!direct || !access->isEmpty()) {
					poll();
					return;
				}
				send(timer, google::refresh(refresh), [=](const Reply &reply) {
					auto obj = reply.json;
					*access = obj.value("access_token").toString().toUtf8();
					if (reply.ok() && !access->isEmpty())
						poll();
					else if (rejected_refresh(reply)) {
						notify_user("Clips can no longer check " + title + kept);
						unpaired(YouTubeRoute::Direct, refresh);
						timer->deleteLater();
					} else
						timer->start(std::min(timer->interval() * 2, 60000));
				});
			});
			timer->start(3000);
		},
		Qt::QueuedConnection);
}
