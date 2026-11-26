#include "replay.hpp"
#include "youtube-google.hpp"

#include <QCryptographicHash>
#include <QDesktopServices>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QPointer>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTimer>
#include <QUrlQuery>
#include <QUuid>
#include <memory>

namespace {
using namespace youtube_http;
std::unique_ptr<QObject> pairing;
QPointer<QTcpServer> sign_in_listener;
const QString direct_scopes = QStringLiteral(
	"https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly");

void sign_in_failed(const std::function<void(bool, const std::string &)> &done, const char *message)
{
	// Local failures have no remote HTTP status. Only log our own fixed messages.
	blog(LOG_WARNING, "[better-clips] %s", message);
	done(false, message);
}

void direct_exchange(QObject *owner, const QString &code, const QString &redirect, const QString &verifier,
		     std::function<void(bool, const std::string &)> done)
{
	auto req = google::token(QUrlQuery({{"grant_type", "authorization_code"},
					    {"code", code},
					    {"redirect_uri", redirect},
					    {"code_verifier", verifier}}));
	send(owner, req, [=](const Reply &r) {
		auto obj = r.json;
		auto refresh = obj.value("refresh_token").toString();
		auto access = obj.value("access_token").toString();
		const auto scopes = obj.value("scope").toString().split(' ');
		for (const auto &scope : direct_scopes.split(' ')) {
			if (!scopes.contains(scope)) {
				blog(LOG_WARNING, "[better-clips] YouTube token exchange failed (%s)",
				     r.diagnostic().c_str());
				done(false, "Sign in again and grant every requested permission.");
				return;
			}
		}
		if (!r.ok() || refresh.isEmpty() || access.isEmpty()) {
			blog(LOG_WARNING, "[better-clips] YouTube token exchange failed (%s)", r.diagnostic().c_str());
			done(false, "Google did not grant offline access. Sign in again.");
			return;
		}
		send(owner,
		     {google::api("/youtube/v3/channels?mine=true&part=snippet"),
		      "GET",
		      {"Authorization: Bearer " + access.toUtf8()}},
		     [=](const Reply &channel) {
			     auto item = channel.json.value("items").toArray().at(0).toObject();
			     auto id = item.value("id").toString();
			     if (!channel.ok() || id.isEmpty()) {
				     blog(LOG_WARNING, "[better-clips] YouTube channel lookup failed (%s)",
					  channel.diagnostic().c_str());
				     done(false,
					  "Could not find your YouTube channel. Check that you have one and try again.");
				     return;
			     }
			     auto yt = get_youtube_settings();
			     yt.route = YouTubeRoute::Direct;
			     yt.refresh_token = refresh.toStdString();
			     yt.app_url.clear();
			     yt.upload_token.clear();
			     yt.channel_id = id.toStdString();
			     yt.channel_title =
				     item.value("snippet").toObject().value("title").toString().toStdString();
			     set_youtube_settings(yt);
			     done(true, "");
		     });
	});
}

} // namespace

bool youtube_direct_available()
{
	return sizeof(YOUTUBE_CLIENT_ID) > 1;
}

void cancel_youtube_sign_in()
{
	delete sign_in_listener.data(); // also cancels pending exchanges owned by the listener
}

void youtube_connect_async(YouTubeRoute route, const std::string &app_url,
			   std::function<void(bool, const std::string &)> done)
{
	cancel_youtube_sign_in();
	const bool direct = route == YouTubeRoute::Direct;
	if (direct && !youtube_direct_available()) {
		sign_in_failed(done, "This build is not configured for direct YouTube uploads.");
		return;
	}
	const QUrl base(QString::fromStdString(app_url));
	if (!direct && (!base.isValid() || !base.userInfo().isEmpty() ||
			(base.scheme() != "https" &&
			 !(base.scheme() == "http" && (base.host() == "127.0.0.1" || base.host() == "localhost"))))) {
		sign_in_failed(done, "The Better Clips app address must use HTTPS.");
		return;
	}
	if (!pairing)
		pairing = std::make_unique<QObject>();
	auto *server = new QTcpServer(pairing.get());
	sign_in_listener = server;
	if (!server->listen(QHostAddress::LocalHost, 0)) {
		server->deleteLater();
		sign_in_failed(done, "Could not listen for sign-in on this computer.");
		return;
	}
	const QString state = QUuid::createUuid().toString(QUuid::WithoutBraces);
	const auto redirect = QStringLiteral("http://127.0.0.1:%1/callback").arg(server->serverPort());
	const QString verifier =
		QUuid::createUuid().toString(QUuid::Id128) + QUuid::createUuid().toString(QUuid::Id128);
	const QString challenge =
		QString::fromLatin1(QCryptographicHash::hash(verifier.toLatin1(), QCryptographicHash::Sha256)
					    .toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));
	auto *timeout = new QTimer(server);
	timeout->setSingleShot(true);
	QObject::connect(timeout, &QTimer::timeout, server, [server, done] {
		server->close();
		server->deleteLater();
		sign_in_failed(done, "Sign-in timed out. Try again.");
	});
	timeout->start(600000);
	QObject::connect(server, &QTcpServer::newConnection, server, [=] {
		auto *s = server->nextPendingConnection();
		s->setReadBufferSize(8192);
		QObject::connect(s, &QTcpSocket::disconnected, s, &QObject::deleteLater);
		QObject::connect(s, &QTcpSocket::readyRead, s, [=] {
			if (!s->canReadLine()) {
				if (s->bytesAvailable() >= 8192)
					s->abort();
				return;
			}
			auto line = s->readLine().split(' ');
			QUrl url = QUrl::fromEncoded(line.value(1));
			QUrlQuery query(url);
			auto code = query.queryItemValue("code");
			if (!server->isListening() || line.value(0) != "GET" || url.path() != "/callback" ||
			    (code.isEmpty() && !query.hasQueryItem("error")) ||
			    query.queryItemValue("state") != state) {
				s->write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nInvalid sign-in.");
				s->disconnectFromHost();
				return;
			}
			server->close();
			timeout->stop();
			s->write(
				"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\nReturn to OBS to finish connecting YouTube.");
			s->flush();
			s->disconnectFromHost();
			if (query.hasQueryItem("error")) {
				server->deleteLater();
				auto encoded = query.queryItemValue("error_description", QUrl::FullyEncoded).toUtf8();
				auto reason =
					QUrl::fromPercentEncoding(encoded.replace('+', ' ')).simplified().left(500);
				done(false, reason.isEmpty() ? query.queryItemValue("error").left(100).toStdString()
							     : reason.toStdString());
				return;
			}
			if (direct) {
				direct_exchange(server, code, redirect, verifier,
						[=](bool ok, const std::string &error) {
							server->deleteLater();
							done(ok, error);
						});
				return;
			}
			send(server,
			     {base.resolved(QUrl("/api/youtube/obs/exchange")),
			      "POST",
			      {"Content-Type: application/json"},
			      QJsonDocument(QJsonObject{{"code", code}, {"verifier", verifier}}).toJson()},
			     [=](const Reply &r) {
				     auto obj = r.json;
				     auto token = obj.value("uploadToken").toString();
				     bool ok = r.ok() && !token.isEmpty() &&
					       !obj.value("channelId").toString().isEmpty();
				     if (ok) {
					     auto yt = get_youtube_settings();
					     yt.route = YouTubeRoute::ClipsApp;
					     yt.refresh_token.clear();
					     yt.app_url = app_url;
					     yt.upload_token = token.toStdString();
					     yt.channel_id = obj.value("channelId").toString().toStdString();
					     yt.channel_title = obj.value("channelTitle").toString().toStdString();
					     set_youtube_settings(yt);
				     } else
					     blog(LOG_WARNING, "[better-clips] YouTube pairing exchange failed (%s)",
						  r.diagnostic().c_str());
				     server->deleteLater();
				     done(ok, ok ? "" : "Could not finish sign-in. Try again.");
			     });
		});
	});
	auto url = base.resolved(QUrl("/api/youtube/connect"));
	url.setQuery(QUrlQuery({{"purpose", "pair"},
				{"obs_port", QString::number(server->serverPort())},
				{"obs_state", state},
				{"obs_challenge", challenge}}));
	if (direct) {
		url = google::endpoint("YOUTUBE_AUTH_BASE", "https://accounts.google.com", "/o/oauth2/v2/auth");
		url.setQuery(QUrlQuery({{"client_id", YOUTUBE_CLIENT_ID},
					{"redirect_uri", redirect},
					{"response_type", "code"},
					{"access_type", "offline"},
					{"prompt", "consent"},
					{"scope", direct_scopes},
					{"state", state},
					{"code_challenge", challenge},
					{"code_challenge_method", "S256"}}));
	}
	if (!QDesktopServices::openUrl(url)) {
		timeout->stop();
		server->close();
		server->deleteLater();
		sign_in_failed(done, "Could not open the browser.");
	}
}

void unpaired(YouTubeRoute route, const std::string &token)
{
	auto current = get_youtube_settings();
	auto &credential = route == YouTubeRoute::Direct ? current.refresh_token : current.upload_token;
	if (current.route != route || token.empty() || credential != token)
		return;
	credential.clear();
	current.channel_title.clear();
	current.channel_id.clear();
	set_youtube_settings(current);
	notify_user(
		"Better Clips: this OBS isn't connected to YouTube any more. Open Tools → Better Clips Settings → YouTube to reconnect.");
}

void check_youtube_pairing()
{
	const auto yt = get_youtube_settings();
	if (yt.route != YouTubeRoute::ClipsApp || yt.upload_token.empty())
		return;
	if (!pairing)
		pairing = std::make_unique<QObject>();
	const auto url = QUrl(QString::fromStdString(yt.app_url)).resolved(QUrl("/api/youtube/obs/status"));
	send(pairing.get(), {url, "GET", {"Authorization: Bearer " + QByteArray::fromStdString(yt.upload_token)}},
	     [token = yt.upload_token](const Reply &r) {
		     if (r.code != CURLE_OK)
			     return;
		     // Older Workers may return their browser sign-in challenge for an unknown path.
		     const auto reason = r.json.value("reason");
		     if (r.status == 401 && (reason == "unpaired" || reason == "revoked")) {
			     unpaired(YouTubeRoute::ClipsApp, token);
			     return;
		     }
		     if (r.status != 200 || !r.json.value("channelTitle").isString())
			     return;
		     const auto id = r.json.value("channelId").toString().toStdString();
		     const auto title = r.json.value("channelTitle").toString().toStdString();
		     auto current = get_youtube_settings();
		     if (current.route != YouTubeRoute::ClipsApp || current.upload_token != token || id.empty() ||
			 (current.channel_id == id && current.channel_title == title))
			     return;
		     current.channel_id = id;
		     current.channel_title = title;
		     set_youtube_settings(current);
	     });
}

void youtube_disconnect(std::function<void(DisconnectResult)> done, bool remove_channel)
{
	auto yt = get_youtube_settings();
	if (!pairing)
		pairing = std::make_unique<QObject>();
	const bool direct = yt.route == YouTubeRoute::Direct;
	const QUrl endpoint(remove_channel ? "/api/youtube/disconnect" : "/api/youtube/obs/unpair");
	auto req = direct ? google::form("/revoke", QUrlQuery({{"token", QString::fromStdString(yt.refresh_token)}}))
			  : Request{QUrl(QString::fromStdString(yt.app_url)).resolved(endpoint),
				    "POST",
				    {"Content-Type: application/json",
				     "Authorization: Bearer " + QByteArray::fromStdString(yt.upload_token)},
				    "{}"};
	send(pairing.get(), req, [direct, remove_channel, yt, done = std::move(done)](const Reply &r) {
		const auto status = r.status;
		const bool invalid = direct ? status == 400 && r.json.value("error") == "invalid_token" : status == 401;
		auto result = invalid                    ? DisconnectResult::Unpaired
			      : !r.ok()                  ? DisconnectResult::Failed
			      : direct || remove_channel ? DisconnectResult::Revoked
							 : DisconnectResult::Unpaired;
		if (result != DisconnectResult::Failed) {
			auto current = get_youtube_settings();
			if (current.route == yt.route && current.upload_token == yt.upload_token &&
			    current.refresh_token == yt.refresh_token) {
				current.upload_token.clear();
				current.refresh_token.clear();
				current.channel_id.clear();
				current.channel_title.clear();
				set_youtube_settings(current);
			}
		} else {
			blog(LOG_WARNING, "[better-clips] YouTube disconnect failed (%s)", r.diagnostic().c_str());
			notify_user("Could not disconnect YouTube. Try again.");
		}
		done(result);
	});
}

void stop_youtube_disconnect()
{
	pairing.reset();
}
