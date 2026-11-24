/* Uploads an in-memory object to Cloudflare R2 (or any S3-compatible store)
 * with a single PUT signed with AWS Signature Version 4. */

#include "replay-r2.hpp"
#include "sha256.hpp"

#include <curl/curl.h>

#include <algorithm>
#include <cctype>
#include <cstring>
#include <ctime>

namespace {

/* R2 accepts "auto"; it is also what Cloudflare's docs use for the S3 API. */
constexpr const char *REGION = "auto";

struct ParsedUrl {
	std::string scheme_host; /* https://host[:port] */
	std::string host;        /* host[:port], sent as the Host header */
	std::string bucket;
	std::string prefix; /* any path after the bucket */
};

std::string trim_slashes(std::string s)
{
	while (!s.empty() && s.front() == '/')
		s.erase(s.begin());
	while (!s.empty() && s.back() == '/')
		s.pop_back();
	return s;
}

bool parse_s3_url(const std::string &url, ParsedUrl &out, std::string &error)
{
	size_t scheme_end = url.find("://");
	if (scheme_end == std::string::npos) {
		error = "The S3 API URL must start with https://";
		return false;
	}
	size_t path_start = url.find('/', scheme_end + 3);
	out.host = url.substr(scheme_end + 3,
			      path_start == std::string::npos ? std::string::npos : path_start - scheme_end - 3);
	out.scheme_host = url.substr(0, scheme_end + 3) + out.host;

	std::string path = path_start == std::string::npos ? "" : trim_slashes(url.substr(path_start));
	size_t slash = path.find('/');
	out.bucket = path.substr(0, slash);
	out.prefix = slash == std::string::npos ? "" : path.substr(slash + 1);

	if (out.host.empty() || out.bucket.empty()) {
		error = "The S3 API URL must include the bucket, like "
			"https://<account-id>.r2.cloudflarestorage.com/<bucket>";
		return false;
	}
	return true;
}

/* URI-encodes per SigV4: keep unreserved characters and, for paths, '/'. */
std::string uri_encode(const std::string &s, bool keep_slash)
{
	static const char hex[] = "0123456789ABCDEF";
	std::string out;
	for (unsigned char c : s) {
		if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~' || (keep_slash && c == '/')) {
			out += (char)c;
		} else {
			out += '%';
			out += hex[c >> 4];
			out += hex[c & 0xf];
		}
	}
	return out;
}

struct ReadState {
	const std::vector<uint8_t> *body;
	size_t pos;
};

size_t read_body(char *buffer, size_t size, size_t nitems, void *userdata)
{
	ReadState *state = (ReadState *)userdata;
	size_t n = (std::min)(size * nitems, state->body->size() - state->pos);
	memcpy(buffer, state->body->data() + state->pos, n);
	state->pos += n;
	return n;
}

size_t collect_response(char *ptr, size_t size, size_t nmemb, void *userdata)
{
	std::string *response = (std::string *)userdata;
	if (response->size() < 4096)
		response->append(ptr, size * nmemb);
	return size * nmemb;
}

/* Pulls <Code> and <Message> out of an S3 XML error response. */
std::string s3_error_summary(const std::string &xml)
{
	auto tag = [&](const char *name) {
		std::string open = std::string("<") + name + ">";
		std::string close = std::string("</") + name + ">";
		size_t a = xml.find(open);
		size_t b = xml.find(close);
		if (a == std::string::npos || b == std::string::npos || b < a)
			return std::string();
		return xml.substr(a + open.size(), b - a - open.size());
	};
	std::string code = tag("Code"), message = tag("Message");
	if (code.empty())
		return {};
	return message.empty() ? code : code + ": " + message;
}

} // namespace

std::string object_key(const R2Config &config, const std::string &name)
{
	ParsedUrl url;
	std::string ignored;
	std::string key;
	if (parse_s3_url(config.s3_url, url, ignored) && !url.prefix.empty())
		key = url.prefix + "/";
	std::string folder = trim_slashes(config.folder);
	if (!folder.empty())
		key += folder + "/";
	return key + name;
}

bool secure_url(const std::string &url)
{
	for (const char *allowed : {"https://", "http://localhost:", "http://127.0.0.1:"})
		if (url.rfind(allowed, 0) == 0)
			return true;
	return false;
}

bool s3_put_object(const R2Config &config, const std::string &key, const std::vector<uint8_t> &body,
		   const char *content_type, std::string &error)
{
	ParsedUrl url;
	if (!parse_s3_url(config.s3_url, url, error))
		return false;
	if (!secure_url(config.s3_url)) {
		error = "The S3 API URL must start with https://";
		return false;
	}
	if (config.access_key.empty() || config.secret_key.empty()) {
		error = "Access Key ID and Secret Access Key are required";
		return false;
	}

	time_t now = time(nullptr);
	struct tm utc;
#ifdef _WIN32
	gmtime_s(&utc, &now);
#else
	gmtime_r(&now, &utc);
#endif
	char amz_date[17], date[9];
	strftime(amz_date, sizeof(amz_date), "%Y%m%dT%H%M%SZ", &utc);
	strftime(date, sizeof(date), "%Y%m%d", &utc);

	const std::string path = "/" + uri_encode(url.bucket, false) + "/" + uri_encode(key, true);
	const std::string payload_hash = to_hex(sha256(body.data(), body.size()));
	const std::string signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date";

	const std::string canonical_request = std::string("PUT\n") + path + "\n" + "\n" +
					      "content-type:" + content_type + "\n" + "host:" + url.host + "\n" +
					      "x-amz-content-sha256:" + payload_hash + "\n" + "x-amz-date:" + amz_date +
					      "\n" + "\n" + signed_headers + "\n" + payload_hash;

	const std::string scope = std::string(date) + "/" + REGION + "/s3/aws4_request";
	const std::string canonical_hash = to_hex(sha256(canonical_request.data(), canonical_request.size()));
	const std::string string_to_sign =
		std::string("AWS4-HMAC-SHA256\n") + amz_date + "\n" + scope + "\n" + canonical_hash;

	const std::string secret = "AWS4" + config.secret_key;
	Sha256Digest k = hmac_sha256(secret.data(), secret.size(), date);
	k = hmac_sha256(k.data(), k.size(), REGION);
	k = hmac_sha256(k.data(), k.size(), "s3");
	k = hmac_sha256(k.data(), k.size(), "aws4_request");
	const std::string signature = to_hex(hmac_sha256(k.data(), k.size(), string_to_sign));

	const std::string authorization = "Authorization: AWS4-HMAC-SHA256 Credential=" + config.access_key + "/" +
					  scope + ", SignedHeaders=" + signed_headers + ", Signature=" + signature;

	CURL *curl = curl_easy_init();
	if (!curl) {
		error = "curl_easy_init failed";
		return false;
	}

	struct curl_slist *headers = nullptr;
	headers = curl_slist_append(headers, ("Host: " + url.host).c_str());
	headers = curl_slist_append(headers, (std::string("Content-Type: ") + content_type).c_str());
	headers = curl_slist_append(headers, ("x-amz-content-sha256: " + payload_hash).c_str());
	headers = curl_slist_append(headers, (std::string("x-amz-date: ") + amz_date).c_str());
	headers = curl_slist_append(headers, authorization.c_str());
	headers = curl_slist_append(headers, "Expect:");

	const std::string request_url = url.scheme_host + path;
	ReadState read_state{&body, 0};
	std::string response;
	char curl_error[CURL_ERROR_SIZE] = {0};

	curl_easy_setopt(curl, CURLOPT_URL, request_url.c_str());
	curl_easy_setopt(curl, CURLOPT_UPLOAD, 1L);
	curl_easy_setopt(curl, CURLOPT_READFUNCTION, read_body);
	curl_easy_setopt(curl, CURLOPT_READDATA, &read_state);
	curl_easy_setopt(curl, CURLOPT_INFILESIZE_LARGE, (curl_off_t)body.size());
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
		return false;
	}
	if (status < 200 || status >= 300) {
		std::string summary = s3_error_summary(response);
		error = "HTTP " + std::to_string(status) + (summary.empty() ? "" : " (" + summary + ")");
		return false;
	}
	return true;
}
