"""Multipart retry contract on the verification skill's local R2 Worker."""
import base64
import http.client
import json
import secrets
from urllib.parse import urlencode


def request(path, method="GET", body=None, *, discard=False):
    conn = http.client.HTTPConnection("localhost", 8788, timeout=15)
    conn.request(method, path, body if isinstance(body, bytes) else json.dumps(body), headers)
    res = conn.getresponse()
    if cookie := res.getheader("set-cookie"):
        headers["cookie"] = cookie.split(";")[0]
    data = None if discard else json.loads(res.read())
    conn.close()
    return res.status, data


if __name__ == "__main__":
    headers = {"content-type": "application/json"}
    assert request("/api/login", "POST", {"password": "local-only-clips-verification"})[0] == 200
    setup = request("/api/setup")[1]["code"].split(":")[1]
    headers["authorization"] = "Bearer " + json.loads(base64.b64decode(setup))["t"]
    name = "2026-11-24/12-15-00_Replay_" + secrets.token_hex(16) + ".mp4"
    status, upload = request("/api/upload/start?name=" + name, "POST")
    assert status == 200
    query = urlencode(upload)
    status, part = request("/api/upload/part?" + query + "&part=1", "PUT", b"test clip")
    assert status == 200
    parts = {"parts": [{"partNumber": 1, "etag": part["etag"]}]}
    complete = "/api/upload/complete?" + query
    assert request(complete, "POST", parts, discard=True)[0] == 200
    assert request(complete, "POST", parts) == (200, {"key": upload["key"]})
    wrong = urlencode({**upload, "key": "replays/other.mp4"})
    assert request("/api/upload/complete?" + wrong, "POST", parts)[0] == 400
    clips = request("/api/clips")[1]["clips"]
    filename = name.rsplit("/", 1)[1]
    assert [(c["key"], c["size"]) for c in clips if c["key"].endswith(filename)] == [(upload["key"], 9)]
    print("Dropped completion response: same key on retry, one 9-byte clip; wrong key refused.")
