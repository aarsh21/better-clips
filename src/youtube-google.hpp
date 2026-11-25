#pragma once

#include "youtube-client.hpp"
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QUrlQuery>

namespace google {
// Test replacements are restricted to loopback, like the Worker's overrides.
inline QUrl endpoint(const char *variable, const char *base, const QString &path)
{
	QUrl url(qEnvironmentVariable(variable));
	if (url.scheme() != "http" || url.host() != "127.0.0.1" || !url.userInfo().isEmpty())
		url = QUrl(base);
	return url.resolved(QUrl(path));
}
inline QUrl api(const QString &path)
{
	return endpoint("YOUTUBE_API", "https://www.googleapis.com", path);
}
inline QNetworkRequest request(const QUrl &url)
{
	QNetworkRequest req(url);
	req.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
	req.setTransferTimeout(15000);
	return req;
}
inline QNetworkReply *form(QNetworkAccessManager &net, const QString &path, const QUrlQuery &fields)
{
	auto req = request(endpoint("YOUTUBE_TOKEN_BASE", "https://oauth2.googleapis.com", path));
	req.setHeader(QNetworkRequest::ContentTypeHeader, "application/x-www-form-urlencoded");
	QByteArray body;
	for (const auto &field : fields.queryItems(QUrl::FullyDecoded)) {
		if (!body.isEmpty())
			body += '&';
		body += QUrl::toPercentEncoding(field.first) + '=' + QUrl::toPercentEncoding(field.second);
	}
	return net.post(req, body);
}
inline QNetworkReply *token(QNetworkAccessManager &net, QUrlQuery fields)
{
	fields.addQueryItem("client_id", YOUTUBE_CLIENT_ID);
	fields.addQueryItem("client_secret", YOUTUBE_CLIENT_SECRET);
	return form(net, "/token", fields);
}
inline QNetworkReply *refresh(QNetworkAccessManager &net, const std::string &credential)
{
	return token(net, QUrlQuery({{"grant_type", "refresh_token"},
				     {"refresh_token", QString::fromStdString(credential)}}));
}
} // namespace google
