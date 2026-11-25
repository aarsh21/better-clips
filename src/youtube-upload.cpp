#include "replay-r2.hpp"

#include <QDateTime>
#include <QEventLoop>
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
};

/* The bearer goes ONLY to the app; the session URL itself authorizes PUTs. */
Reply request(QNetworkAccessManager &net, const QUrl &url, const QByteArray &bearer, const QByteArray &range,
	      const QByteArray &body, std::string &error)
{
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
	if (put)
		req.setRawHeader("Content-Range", range);
	req.setHeader(QNetworkRequest::ContentTypeHeader, put ? "video/mp4" : "application/json");
	QNetworkReply *reply = put ? net.put(req, body) : net.post(req, body);
	QEventLoop loop;
	QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
	if (!reply->isFinished())
		loop.exec();
	Reply result{reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), reply->rawHeader("Range"),
		     QJsonDocument::fromJson(reply->readAll()).object()};
	if (reply->error() != QNetworkReply::NoError || (result.status != 308 && result.status / 100 != 2)) {
		auto message = result.json.value("error");
		const QString reason = message.toObject().value("message").toString();
		error = message.toString(reason).toStdString();
		if (error.empty())
			error = "YouTube upload connection failed (HTTP " + std::to_string(result.status) + ")";
		result.status = 0;
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
		    YouTubeSession &session, std::string &link, std::string &error)
{
	QNetworkAccessManager net;
	auto app = [&](const char *path, QJsonObject data) {
		return request(net, QUrl(text(clip.youtube.app_url)).resolved(QUrl(path)),
			       QByteArray::fromStdString(clip.youtube.upload_token), {},
			       QJsonDocument(data).toJson(QJsonDocument::Compact), error);
	};
	bool query = !session.url.empty();
	if (!query) {
		auto r = app("/api/youtube/upload/start",
			     {{"title", text(details.title)},
			      {"description", text(details.description)},
			      {"privacy", text(details.privacy)},
			      {"size", static_cast<qint64>(mp4.size())},
			      {"category", text(clip.game)},
			      {"recordedAt",
			       QDateTime::fromSecsSinceEpoch(clip.recorded_at).toUTC().toString(Qt::ISODate)}});
		if (!r.status)
			return false;
		session.url = r.json.value("sessionUrl").toString().toStdString();
		session.clip_id = r.json.value("clipId").toString().toStdString();
	}
	if (session.url.empty() || session.clip_id.empty()) {
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
		auto r = request(net, QUrl(text(session.url)), {}, range,
				 QByteArray::fromRawData(reinterpret_cast<const char *>(mp4.data() + offset), n),
				 error);
		if (!r.status)
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
	auto r = app("/api/youtube/upload/complete",
		     {{"videoId", text(session.video_id)}, {"clipId", text(session.clip_id)}});
	if (!r.status)
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
	QNetworkRequest req(url);
	req.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
	req.setRawHeader("Authorization", "Bearer " + QByteArray::fromStdString(settings.upload_token));
	req.setTransferTimeout(15000);
	QMetaObject::invokeMethod(
		network,
		[network, req, title] {
			auto *timer = new QTimer(network);
			timer->setSingleShot(true);
			QObject::connect(timer, &QTimer::timeout, timer, [=] {
				auto *reply = network->get(req);
				QObject::connect(reply, &QNetworkReply::finished, timer, [=] {
					const auto status = QJsonDocument::fromJson(reply->readAll())
								    .object()
								    .value("status")
								    .toString();
					const int http =
						reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
					reply->deleteLater();
					if (http == 200 && status == "ready")
						notify_user("YouTube: " + title + " is ready to play.");
					else if (http == 200 && status == "failed")
						notify_user("YouTube could not process " + title +
							    ". Check the video in YouTube Studio.");
					else if (http == 401 || http == 404)
						notify_user("Clips can no longer check " + title +
							    ". Check the video in YouTube Studio.");
					else {
						timer->start(std::min(timer->interval() * 2, 60000));
						return;
					}
					timer->deleteLater();
				});
				// The deadline can end a watch while this reply is still in flight.
				QObject::connect(timer, &QObject::destroyed, reply, &QObject::deleteLater);
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
