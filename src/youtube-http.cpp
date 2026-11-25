#include "youtube-http.hpp"

#include <QJsonDocument>
#include <QObject>
#include <thread>

namespace youtube_http {
std::string Reply::diagnostic() const
{
	return code == CURLE_OK ? "HTTP " + std::to_string(status) : std::string("curl: ") + curl_easy_strerror(code);
}

namespace {
size_t collect(char *data, size_t size, size_t n, void *ctx)
{
	static_cast<QByteArray *>(ctx)->append(data, static_cast<qsizetype>(size * n));
	return size * n;
}

size_t header(char *data, size_t size, size_t n, void *ctx)
{
	auto &reply = *static_cast<Reply *>(ctx);
	auto line = QByteArray::fromRawData(data, static_cast<qsizetype>(size * n));
	auto key = line.left(line.indexOf(':'));
	if (line.startsWith("HTTP/")) {
		reply.range.clear();
		reply.location.clear();
	} else if (key.compare("Range", Qt::CaseInsensitive) == 0)
		reply.range = line.mid(key.size() + 1).trimmed();
	else if (key.compare("Location", Qt::CaseInsensitive) == 0)
		reply.location = line.mid(key.size() + 1).trimmed();
	return size * n;
}

class Pending final : public QObject {
	std::atomic<bool> stop{false};
	std::thread worker;

public:
	Pending(QObject *owner, Request request, std::function<void(const Reply &)> done)
		: QObject(owner),
		  worker([this, request = std::move(request), done = std::move(done)] {
			  auto reply = perform(request, stop);
			  QMetaObject::invokeMethod(
				  this,
				  [this, done, reply] {
					  deleteLater();
					  done(reply);
				  },
				  Qt::QueuedConnection);
		  })
	{
	}
	~Pending() override
	{
		stop = true;
		worker.join();
	}
};
} // namespace

Reply perform(const Request &request, const std::atomic<bool> &stop)
{
	Reply reply;
	const auto &url = request.url;
	if (!url.isValid() || !url.userInfo().isEmpty() ||
	    (url.scheme() != "https" &&
	     !(url.scheme() == "http" && (url.host() == "localhost" || url.host() == "127.0.0.1")))) {
		reply.code = CURLE_URL_MALFORMAT;
		return reply;
	}
	auto *easy = curl_easy_init();
	auto *multi = curl_multi_init();
	curl_slist *headers = nullptr;
	QByteArray body;
	reply.code = CURLE_FAILED_INIT;
	if (easy && multi) {
		for (const auto &h : request.headers)
			headers = curl_slist_append(headers, h.constData());
		headers = curl_slist_append(headers, "Expect:");
		curl_easy_setopt(easy, CURLOPT_URL, url.toEncoded().constData());
		curl_easy_setopt(easy, CURLOPT_NOSIGNAL, 1L);
		curl_easy_setopt(easy, CURLOPT_CONNECTTIMEOUT, request.idle_seconds);
		curl_easy_setopt(easy, CURLOPT_LOW_SPEED_LIMIT, 1L);
		curl_easy_setopt(easy, CURLOPT_LOW_SPEED_TIME, request.idle_seconds);
		curl_easy_setopt(easy, CURLOPT_CUSTOMREQUEST, request.method);
		if (qstrcmp(request.method, "GET") != 0) {
			curl_easy_setopt(easy, CURLOPT_POSTFIELDS, request.body.constData());
			curl_easy_setopt(easy, CURLOPT_POSTFIELDSIZE_LARGE,
					 static_cast<curl_off_t>(request.body.size()));
		}
		curl_easy_setopt(easy, CURLOPT_HTTPHEADER, headers);
		curl_easy_setopt(easy, CURLOPT_WRITEFUNCTION, collect);
		curl_easy_setopt(easy, CURLOPT_WRITEDATA, &body);
		curl_easy_setopt(easy, CURLOPT_HEADERFUNCTION, header);
		curl_easy_setopt(easy, CURLOPT_HEADERDATA, &reply);
		// Bound shutdown latency even when a PUT is waiting for the peer and no bytes move.
		auto rc = curl_multi_add_handle(multi, easy);
		int running = 1;
		while (rc == CURLM_OK && running && !stop) {
			rc = curl_multi_perform(multi, &running);
			if (rc == CURLM_OK && running)
				rc = curl_multi_poll(multi, nullptr, 0, 50, nullptr);
		}
		int left = 0;
		if (stop)
			reply.code = CURLE_ABORTED_BY_CALLBACK;
		else if (auto *msg = curl_multi_info_read(multi, &left); msg && msg->msg == CURLMSG_DONE)
			reply.code = msg->data.result;
		curl_easy_getinfo(easy, CURLINFO_RESPONSE_CODE, &reply.status);
		curl_multi_remove_handle(multi, easy);
	}
	if (multi)
		curl_multi_cleanup(multi);
	if (easy)
		curl_easy_cleanup(easy);
	curl_slist_free_all(headers);
	reply.json = QJsonDocument::fromJson(body).object();
	return reply;
}

void send(QObject *owner, Request request, std::function<void(const Reply &)> done)
{
	new Pending(owner, std::move(request), std::move(done));
}
} // namespace youtube_http
