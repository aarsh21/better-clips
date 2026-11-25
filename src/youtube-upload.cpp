#include "replay-r2.hpp"
#include "youtube-google.hpp"

#include <QDateTime>
#include <QEventLoop>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QTimer>
#include <QUrlQuery>

namespace {
QString text(const std::string &s)
{
	return QString::fromStdString(s);
}

struct Reply {
	int status;
	QByteArray range;
	QJsonObject json;
	QString reason;
	QByteArray location;
};

Reply await_reply(QNetworkReply *reply, std::string &error, const std::atomic<bool> &stopping);

Reply request(QNetworkAccessManager &net, const QUrl &url, const QByteArray &bearer, const QByteArray &range,
	      const QByteArray &body, std::string &error, const std::atomic<bool> &stopping, qint64 upload_size = -1)
{
	if (stopping) {
		error = "OBS is closing";
		return {};
	}
	if (!url.isValid() || !url.userInfo().isEmpty() ||
	    (url.scheme() != "https" &&
	     !(url.scheme() == "http" && (url.host() == "localhost" || url.host() == "127.0.0.1")))) {
		error = "Upload address must use HTTPS.";
		return {};
	}
	QNetworkRequest req(url);
	req.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
	req.setTransferTimeout(60000);
	if (!bearer.isEmpty())
		req.setRawHeader("Authorization", "Bearer " + bearer);
	const bool put = !range.isEmpty();
	if (upload_size >= 0) {
		req.setRawHeader("X-Upload-Content-Length", QByteArray::number(upload_size));
		req.setRawHeader("X-Upload-Content-Type", "video/mp4");
	}
	if (put)
		req.setRawHeader("Content-Range", range);
	req.setHeader(QNetworkRequest::ContentTypeHeader, put ? "video/mp4" : "application/json");
	return await_reply(put ? net.put(req, body) : net.post(req, body), error, stopping);
}

Reply await_reply(QNetworkReply *reply, std::string &error, const std::atomic<bool> &stopping)
{
	QEventLoop loop;
	QTimer cancel;
	QObject::connect(&cancel, &QTimer::timeout, reply, [&] {
		if (stopping)
			reply->abort();
	});
	cancel.start(50);
	QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
	if (!reply->isFinished())
		loop.exec();
	Reply result{reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(),
		     reply->rawHeader("Range"),
		     QJsonDocument::fromJson(reply->readAll()).object(),
		     {},
		     reply->rawHeader("Location")};
	if (reply->error() != QNetworkReply::NoError || (result.status != 308 && result.status / 100 != 2)) {
		auto message = result.json.value("error");
		const auto details = message.toObject();
		result.reason = details.value("errors").toArray().at(0).toObject().value("reason").toString();
		error = message.toString(details.value("message").toString(result.reason)).toStdString();
		if (error.empty())
			error = "YouTube upload connection failed (HTTP " + std::to_string(result.status) + ")";
		if (result.status / 100 == 2 || result.status == 308)
			result.status = 0; // Incomplete response, even if its headers arrived.
	}
	delete reply;
	return result;
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
	QNetworkAccessManager net;
	const bool direct = clip.youtube.route == YouTubeRoute::Direct;
	QByteArray bearer;
	auto google_request = [&](QUrl url, const QByteArray &range, const QByteArray &body, qint64 size = -1) {
		for (int attempt = 0;; ++attempt) {
			if (stopping)
				return Reply{};
			if (bearer.isEmpty()) {
				auto token =
					await_reply(google::refresh(net, clip.youtube.refresh_token), error, stopping);
				if (token.status / 100 != 2) {
					if (token.json.value("error") == "invalid_grant")
						error = "YouTube access expired. Sign in again.";
					return token;
				}
				bearer = token.json.value("access_token").toString().toUtf8();
				if (bearer.isEmpty()) {
					error = "Google did not return an access token.";
					return Reply{};
				}
			}
			auto reply = request(net, url, bearer, range, body, error, stopping, size);
			if (reply.status != 401 || attempt != 0)
				return reply;
			bearer.clear();
		}
	};
	auto failed = [&](const Reply &reply) {
		const auto status = reply.status;
		session.permanent_failure = status / 100 == 4 && status != 408 && status != 409 && status != 429 &&
					    !(status == 403 && (reply.reason == "rateLimitExceeded" ||
								reply.reason == "userRateLimitExceeded"));
		return status / 100 != 2;
	};
	auto app = [&](const char *path, QJsonObject data) {
		return request(net, QUrl(text(clip.youtube.app_url)).resolved(QUrl(path)),
			       QByteArray::fromStdString(clip.youtube.upload_token), {},
			       QJsonDocument(data).toJson(QJsonDocument::Compact), error, stopping);
	};
	bool query = !session.url.empty();
	if (!query && direct) {
		const auto api = google::api("/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status");
		QJsonObject meta{{"snippet", QJsonObject{{"title", text(details.title)},
							 {"description", text(details.description)},
							 {"categoryId", "20"}}},
				 {"status", QJsonObject{{"privacyStatus", text(details.privacy)}}}};
		auto r = google_request(api, {}, QJsonDocument(meta).toJson(), static_cast<qint64>(mp4.size()));
		if (failed(r))
			return false;
		auto location = QUrl::fromEncoded(r.location);
		if (location.scheme() != api.scheme() || location.authority() != api.authority()) {
			error = "Google returned an unexpected upload address.";
			session.permanent_failure = true;
			return false;
		}
		session.url = location.toEncoded().toStdString();
	} else if (!query) {
		auto r = app("/api/youtube/upload/start",
			     {{"title", text(details.title)},
			      {"description", text(details.description)},
			      {"privacy", text(details.privacy)},
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
		error = "The Clips app did not open a YouTube upload.";
		return false;
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
		auto r = direct ? google_request(url, range, bytes)
				: request(net, url, {}, range, bytes, error, stopping);
		if (!direct && (r.status == 404 || r.status == 410)) {
			session = {}; // Explicitly expired; no video ID has been confirmed.
			return false;
		}
		if (r.status != 308 && failed(r))
			return false;
		if (r.status == 308) {
			bool ok = false;
			qint64 last = r.range.mid(8).toLongLong(&ok);
			if (!r.range.isEmpty() &&
			    (!r.range.startsWith("bytes=0-") || !ok || last < 0 || last >= total - 1)) {
				error = "YouTube reported an unexpected upload position.";
				return false;
			}
			qint64 next = r.range.isEmpty() ? 0 : last + 1;
			if (!query && next <= offset) {
				error = "YouTube has not received this part yet.";
				return false;
			}
			offset = next;
			query = false;
			continue;
		}
		session.video_id = r.json.value("id").toString().toStdString();
		if (session.video_id.empty()) {
			error = "Waiting for YouTube to confirm the upload.";
			return false;
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
		error = "The Clips app did not confirm the video link.";
		return false;
	}
	return true;
}

/* Schedule lightweight checks on Qt's event loop, with no retained clip data
 * or sleeping upload thread. The uploader owns network for its whole life. */
void youtube_watch(QNetworkAccessManager *network, const YouTubeSettings &settings, const std::string &clip_id,
		   const std::string &title)
{
	QUrl url = QUrl(text(settings.app_url)).resolved(QUrl("/api/youtube/upload/status"));
	url.setQuery(QUrlQuery({{"clipId", text(clip_id)}}));
	const bool direct = settings.route == YouTubeRoute::Direct;
	if (direct) {
		url = google::api("/youtube/v3/videos");
		url.setQuery(QUrlQuery({{"part", "status"}, {"id", text(clip_id)}}));
	}
	QNetworkRequest req(url);
	req.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
	req.setRawHeader("Authorization", "Bearer " + QByteArray::fromStdString(settings.upload_token));
	req.setTransferTimeout(15000);
	QMetaObject::invokeMethod(
		network,
		[network, req, title, direct, refresh = settings.refresh_token] {
			auto *timer = new QTimer(network);
			timer->setSingleShot(true);
			auto access = std::make_shared<QByteArray>();
			auto poll = [=] {
				auto request = req;
				if (direct)
					request.setRawHeader("Authorization", "Bearer " + *access);
				auto *reply = network->get(request);
				QObject::connect(reply, &QNetworkReply::finished, timer, [=] {
					auto obj = QJsonDocument::fromJson(reply->readAll()).object();
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
					const int http =
						reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
					reply->deleteLater();
					if (http == 200 && status == "ready")
						notify_user("YouTube: " + title + " is ready to play.");
					else if (http == 200 && status == "failed")
						notify_user("YouTube could not process " + title +
							    ". Check the video in YouTube Studio.");
					else if ((!direct && http == 401) || http == 404)
						notify_user("Clips can no longer check " + title +
							    ". Check the video in YouTube Studio.");
					else {
						if (direct && http == 401)
							access->clear();
						timer->start(std::min(timer->interval() * 2, 60000));
						return;
					}
					timer->deleteLater();
				});
				// The deadline can end a watch while this reply is still in flight.
				QObject::connect(timer, &QObject::destroyed, reply, &QObject::deleteLater);
			};
			QObject::connect(timer, &QTimer::timeout, timer, [=] {
				if (!direct || !access->isEmpty()) {
					poll();
					return;
				}
				auto *reply = google::refresh(*network, refresh);
				QObject::connect(timer, &QObject::destroyed, reply, &QObject::deleteLater);
				QObject::connect(reply, &QNetworkReply::finished, timer, [=] {
					auto obj = QJsonDocument::fromJson(reply->readAll()).object();
					reply->deleteLater();
					*access = obj.value("access_token").toString().toUtf8();
					if (reply->error() == QNetworkReply::NoError && !access->isEmpty())
						poll();
					else if (obj.value("error") == "invalid_grant") {
						notify_user("Clips can no longer check " + title +
							    ". Check the video in YouTube Studio.");
						timer->deleteLater();
					} else
						timer->start(std::min(timer->interval() * 2, 60000));
				});
			});
			QTimer::singleShot(600000, timer, [=] {
				notify_user("Clips stopped waiting for " + title +
					    ". Check its progress in YouTube Studio.");
				timer->deleteLater();
			});
			timer->start(3000);
		},
		Qt::QueuedConnection);
}
