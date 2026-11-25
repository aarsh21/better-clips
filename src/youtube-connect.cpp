#include "replay-r2.hpp"
#include "youtube-google.hpp"

#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDesktopServices>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTimer>
#include <QUrlQuery>
#include <QUuid>
#include <memory>

namespace {
std::unique_ptr<QNetworkAccessManager> disconnect_net;
std::unique_ptr<QObject> pairing;
const QString direct_scopes = QStringLiteral(
	"openid email https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly");

void direct_exchange(QNetworkAccessManager *net, const QString &code, const QString &redirect, const QString &verifier,
		     std::function<void(bool, const std::string &)> done)
{
	auto *r = google::token(*net, QUrlQuery({{"grant_type", "authorization_code"},
						 {"code", code},
						 {"redirect_uri", redirect},
						 {"code_verifier", verifier}}));
	QObject::connect(r, &QNetworkReply::finished, net, [=] {
		auto obj = QJsonDocument::fromJson(r->readAll()).object();
		auto refresh = obj.value("refresh_token").toString();
		auto access = obj.value("access_token").toString();
		auto scopes = obj.value("scope").toString().split(' ');
		if (scopes.contains("https://www.googleapis.com/auth/userinfo.email"))
			scopes.append("email");
		for (const auto &scope : direct_scopes.split(' ')) {
			if (!scopes.contains(scope)) {
				done(false, "Sign in again and grant every requested permission.");
				return;
			}
		}
		if (r->error() != QNetworkReply::NoError || refresh.isEmpty() || access.isEmpty()) {
			done(false, "Google did not grant offline access. Sign in again.");
			return;
		}
		auto req = google::request(google::api("/youtube/v3/channels?mine=true&part=snippet"));
		req.setRawHeader("Authorization", "Bearer " + access.toUtf8());
		auto *channel = net->get(req);
		QObject::connect(channel, &QNetworkReply::finished, net, [=] {
			auto item = QJsonDocument::fromJson(channel->readAll())
					    .object()
					    .value("items")
					    .toArray()
					    .at(0)
					    .toObject();
			auto id = item.value("id").toString();
			if (channel->error() != QNetworkReply::NoError || id.isEmpty()) {
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
			yt.channel_title = item.value("snippet").toObject().value("title").toString().toStdString();
			set_youtube_settings(yt);
			done(true, "");
		});
	});
}

QNetworkRequest app_request(QUrl url)
{
	QNetworkRequest req(url);
	req.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
	req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
	req.setTransferTimeout(15000);
	return req;
}
} // namespace

bool youtube_direct_available()
{
	return sizeof(YOUTUBE_CLIENT_ID) > 1;
}

void youtube_connect_async(YouTubeRoute route, const std::string &app_url,
			   std::function<void(bool, const std::string &)> done)
{
	const bool direct = route == YouTubeRoute::Direct;
	if (direct && !youtube_direct_available()) {
		done(false, "This build is not configured for direct YouTube uploads.");
		return;
	}
	const QUrl base(QString::fromStdString(app_url));
	if (!direct && (!base.isValid() || !base.userInfo().isEmpty() ||
			(base.scheme() != "https" &&
			 !(base.scheme() == "http" && (base.host() == "127.0.0.1" || base.host() == "localhost"))))) {
		done(false, "The Clips app address must use HTTPS.");
		return;
	}
	if (!pairing)
		pairing = std::make_unique<QObject>();
	auto *server = new QTcpServer(pairing.get());
	if (!server->listen(QHostAddress::LocalHost, 0)) {
		server->deleteLater();
		done(false, "Could not listen for sign-in on this computer.");
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
		done(false, "Sign-in timed out. Try again.");
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
			s->disconnectFromHost();
			if (code.isEmpty()) {
				server->deleteLater();
				done(false, "YouTube sign-in was cancelled.");
				return;
			}
			auto *net = new QNetworkAccessManager(server);
			if (direct) {
				direct_exchange(net, code, redirect, verifier, [=](bool ok, const std::string &error) {
					server->deleteLater();
					done(ok, error);
				});
				return;
			}
			auto *r =
				net->post(app_request(base.resolved(QUrl("/api/youtube/obs/exchange"))),
					  QJsonDocument(QJsonObject{{"code", code}, {"verifier", verifier}}).toJson());
			QObject::connect(r, &QNetworkReply::finished, server, [=] {
				auto obj = QJsonDocument::fromJson(r->readAll()).object();
				auto token = obj.value("uploadToken").toString();
				bool ok = r->error() == QNetworkReply::NoError && !token.isEmpty() &&
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
				}
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
		done(false, "Could not open the browser.");
	}
}

void youtube_disconnect(std::function<void(DisconnectResult)> done)
{
	auto yt = get_youtube_settings();
	if (!disconnect_net)
		disconnect_net = std::make_unique<QNetworkAccessManager>();
	auto req = app_request(QUrl(QString::fromStdString(yt.app_url)).resolved(QUrl("/api/youtube/disconnect")));
	req.setRawHeader("Authorization", "Bearer " + QByteArray::fromStdString(yt.upload_token));
	const bool direct = yt.route == YouTubeRoute::Direct;
	auto *r = direct ? google::form(*disconnect_net, "/revoke",
					QUrlQuery({{"token", QString::fromStdString(yt.refresh_token)}}))
			 : disconnect_net->post(req, "{}");
	QObject::connect(r, &QNetworkReply::finished, r, [r, direct, yt, done = std::move(done)] {
		const int status = r->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
		const bool invalid = direct ? status == 400 &&
						      QJsonDocument::fromJson(r->readAll()).object().value("error") ==
							      "invalid_token"
					    : status == 401;
		auto result = invalid                                                     ? DisconnectResult::Unpaired
			      : status / 100 == 2 && r->error() == QNetworkReply::NoError ? DisconnectResult::Revoked
											  : DisconnectResult::Failed;
		r->deleteLater();
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
			notify_user("Could not disconnect YouTube. Try again.");
		}
		done(result);
	});
}

void stop_youtube_disconnect()
{
	pairing.reset();
	disconnect_net.reset();
}
