#pragma once

#include <QJsonObject>
#include <QUrl>
#include <curl/curl.h>
#include <atomic>
#include <functional>

namespace youtube_http {
inline bool permanent_http_error(long status)
{
	return status / 100 == 4 && status != 408 && status != 409 && status != 429;
}

inline void cancel_on_stop(CURL *curl, const std::atomic<bool> &stop)
{
	curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
	curl_easy_setopt(curl, CURLOPT_XFERINFODATA, &stop);
	curl_easy_setopt(
		curl, CURLOPT_XFERINFOFUNCTION, +[](void *ctx, curl_off_t, curl_off_t, curl_off_t, curl_off_t) -> int {
			return static_cast<const std::atomic<bool> *>(ctx)->load();
		});
}

struct Request {
	QUrl url;
	const char *method = "GET";
	QList<QByteArray> headers{};
	QByteArray body{};
	long idle_seconds = 15;
};
struct Reply {
	long status = 0;
	CURLcode code = CURLE_OK;
	QJsonObject json;
	QByteArray range, location;
	bool ok() const { return code == CURLE_OK && status / 100 == 2; }
	std::string diagnostic() const;
};
Reply perform(const Request &request, const std::atomic<bool> &stop);
// Called on the UI thread. Destroying owner cancels the transfer and drops its callback.
void send(QObject *owner, Request request, std::function<void(const Reply &)> done);
} // namespace youtube_http
