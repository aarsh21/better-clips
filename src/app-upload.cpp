/* Uploads clips through the clips app (web/worker), which writes them to its
 * R2 bucket, so you need no R2 API keys. The app is a Cloudflare Worker, whose
 * request bodies are capped at 100 MB, so clips go up as a multipart upload:
 * start, then parts of up to 50 MB, then complete. */

#include "replay-r2.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <cstring>

namespace {

/* R2 needs every part but the last to be the same size. */
constexpr size_t PART_SIZE = 50 * 1024 * 1024;

struct Body {
	const uint8_t *data;
	size_t size;
	size_t pos;
};

size_t read_body(char *buffer, size_t size, size_t nitems, void *userdata)
{
	Body *body = (Body *)userdata;
	size_t n = (std::min)(size * nitems, body->size - body->pos);
	if (n) {
		memcpy(buffer, body->data + body->pos, n);
		body->pos += n;
	}
	return n;
}

size_t collect_response(char *ptr, size_t size, size_t nmemb, void *userdata)
{
	std::string *response = (std::string *)userdata;
	if (response->size() < 65536)
		response->append(ptr, size * nmemb);
	return size * nmemb;
}

std::string escape(const std::string &text)
{
	char *escaped = curl_easy_escape(nullptr, text.c_str(), (int)text.size());
	std::string result = escaped ? escaped : "";
	curl_free(escaped);
	return result;
}

/* Sends one request to the app and returns its JSON answer, or nullptr with
 * error set. GET sends no body; other methods send size bytes of data. */
obs_data_t *call(const R2Config &config, const char *method, const std::string &path, const char *content_type,
		 const uint8_t *data, size_t size, std::string &error)
{
	std::string url = config.app_url;
	while (!url.empty() && url.back() == '/')
		url.pop_back();
	if (!secure_url(url)) {
		error = "The Clips app URL must start with https://";
		return nullptr;
	}
	url += path;

	CURL *curl = curl_easy_init();
	if (!curl) {
		error = "curl_easy_init failed";
		return nullptr;
	}

	struct curl_slist *headers = nullptr;
	headers = curl_slist_append(headers, ("Authorization: Bearer " + config.upload_token).c_str());
	headers = curl_slist_append(headers, (std::string("Content-Type: ") + content_type).c_str());
	headers = curl_slist_append(headers, "Expect:");

	Body body{data, size, 0};
	std::string response;
	char curl_error[CURL_ERROR_SIZE] = {0};

	curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
	if (strcmp(method, "GET") != 0) {
		curl_easy_setopt(curl, CURLOPT_UPLOAD, 1L);
		curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, method);
		curl_easy_setopt(curl, CURLOPT_READFUNCTION, read_body);
		curl_easy_setopt(curl, CURLOPT_READDATA, &body);
		curl_easy_setopt(curl, CURLOPT_INFILESIZE_LARGE, (curl_off_t)size);
	}
	curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
	curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, collect_response);
	curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
	curl_easy_setopt(curl, CURLOPT_ERRORBUFFER, curl_error);
	curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
	curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 15L);
	/* Give up when the connection stalls below 1 KB/s for 60 seconds. */
	curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, 1024L);
	curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, 60L);

	CURLcode res = curl_easy_perform(curl);
	long status = 0;
	curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
	curl_slist_free_all(headers);
	curl_easy_cleanup(curl);

	if (res != CURLE_OK) {
		error = curl_error[0] ? curl_error : curl_easy_strerror(res);
		return nullptr;
	}

	obs_data_t *reply = response.rfind("{", 0) == 0 ? obs_data_create_from_json(response.c_str()) : nullptr;
	if (status < 200 || status >= 300) {
		const char *message = reply ? obs_data_get_string(reply, "error") : "";
		error = "HTTP " + std::to_string(status) +
			(*message ? std::string(" (") + message + ")" : ". Is the Clips app URL right?");
		obs_data_release(reply);
		return nullptr;
	}
	if (!reply)
		error = "Unexpected answer from " + url + ". Is the Clips app URL right?";
	return reply;
}

} // namespace

bool app_upload(const R2Config &config, const std::string &name, const std::vector<uint8_t> &mp4, std::string &key,
		std::string &error)
{
	obs_data_t *started = call(config, "POST", "/api/upload/start?name=" + escape(name), "application/octet-stream",
				   nullptr, 0, error);
	if (!started)
		return false;
	const std::string target = obs_data_get_string(started, "key");
	const std::string query =
		"?key=" + escape(target) + "&uploadId=" + escape(obs_data_get_string(started, "uploadId"));
	obs_data_release(started);

	obs_data_array_t *parts = obs_data_array_create();
	bool ok = true;
	for (size_t offset = 0, number = 1; ok && offset < mp4.size(); offset += PART_SIZE, number++) {
		size_t size = (std::min)(PART_SIZE, mp4.size() - offset);
		obs_data_t *uploaded = call(config, "PUT",
					    "/api/upload/part" + query + "&part=" + std::to_string(number),
					    "application/octet-stream", mp4.data() + offset, size, error);
		ok = uploaded != nullptr;
		if (ok) {
			obs_data_t *part = obs_data_create();
			obs_data_set_int(part, "partNumber", (long long)number);
			obs_data_set_string(part, "etag", obs_data_get_string(uploaded, "etag"));
			obs_data_array_push_back(parts, part);
			obs_data_release(part);
			obs_data_release(uploaded);
		}
	}

	if (ok) {
		obs_data_t *request = obs_data_create();
		obs_data_set_array(request, "parts", parts);
		const char *json = obs_data_get_json(request);
		obs_data_t *done = call(config, "POST", "/api/upload/complete" + query, "application/json",
					(const uint8_t *)json, strlen(json), error);
		ok = done != nullptr;
		if (ok)
			key = obs_data_get_string(done, "key");
		obs_data_release(done);
		obs_data_release(request);
	}
	obs_data_array_release(parts);

	/* Throw away the uploaded parts; a retry starts a new upload. */
	if (!ok) {
		std::string ignored;
		obs_data_release(
			call(config, "POST", "/api/upload/abort" + query, "application/json", nullptr, 0, ignored));
	}
	return ok;
}

bool app_check(const R2Config &config, std::string &error)
{
	if (config.upload_token.empty()) {
		error = "Paste the setup code from Connect OBS in your clips app";
		return false;
	}
	obs_data_t *reply = call(config, "GET", "/api/upload/check", "application/json", nullptr, 0, error);
	bool ok = reply != nullptr;
	obs_data_release(reply);
	return ok;
}
