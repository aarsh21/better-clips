#include "replay-r2.hpp"

#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDesktopServices>
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

QNetworkRequest app_request(QUrl url)
{
	QNetworkRequest req(url);
	req.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
	req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
	req.setTransferTimeout(15000);
	return req;
}
} // namespace

void youtube_connect_async(const std::string &app_url, std::function<void(bool, const std::string &)> done)
{
	const QUrl base(QString::fromStdString(app_url));
	if (!base.isValid() || !base.userInfo().isEmpty() ||
	    (base.scheme() != "https" &&
	     !(base.scheme() == "http" && (base.host() == "127.0.0.1" || base.host() == "localhost")))) {
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
			    code.isEmpty() || query.queryItemValue("state") != state) {
				s->write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nInvalid sign-in.");
				s->disconnectFromHost();
				return;
			}
			server->close();
			timeout->stop();
			s->write(
				"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\nReturn to OBS to finish connecting YouTube.");
			s->disconnectFromHost();
			auto *net = new QNetworkAccessManager(server);
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
	auto *r = disconnect_net->post(req, "{}");
	QObject::connect(r, &QNetworkReply::finished, r, [r, token = yt.upload_token, done = std::move(done)] {
		const int status = r->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
		auto result = status == 401       ? DisconnectResult::Unpaired
			      : status / 100 == 2 ? DisconnectResult::Revoked
						  : DisconnectResult::Failed;
		r->deleteLater();
		if (result != DisconnectResult::Failed) {
			auto current = get_youtube_settings();
			if (current.upload_token == token) {
				current.upload_token.clear();
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
