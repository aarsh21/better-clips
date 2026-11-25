#pragma once

#include "youtube-client.hpp"
#include "youtube-http.hpp"
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
inline youtube_http::Request form(const QString &path, const QUrlQuery &fields)
{
	QByteArray body;
	for (const auto &field : fields.queryItems(QUrl::FullyDecoded)) {
		if (!body.isEmpty())
			body += '&';
		body += QUrl::toPercentEncoding(field.first) + '=' + QUrl::toPercentEncoding(field.second);
	}
	return {endpoint("YOUTUBE_TOKEN_BASE", "https://oauth2.googleapis.com", path),
		"POST",
		{"Content-Type: application/x-www-form-urlencoded"},
		body};
}
inline youtube_http::Request token(QUrlQuery fields)
{
	fields.addQueryItem("client_id", YOUTUBE_CLIENT_ID);
	fields.addQueryItem("client_secret", YOUTUBE_CLIENT_SECRET);
	return form("/token", fields);
}
inline youtube_http::Request refresh(const std::string &credential)
{
	return token(
		QUrlQuery({{"grant_type", "refresh_token"}, {"refresh_token", QString::fromStdString(credential)}}));
}
} // namespace google
