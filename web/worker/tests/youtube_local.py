"""Google/YouTube protocol fake and end-to-end exercise. Run from the repo root:

Set up local hosted Wrangler as in web/.dev.vars.example, with test-client,
test-secret, and both optional localhost overrides set to http://127.0.0.1:9393.
Start Wrangler, then: python3 web/worker/tests/youtube_local.py
Pass --serve instead for an interactive fake (one disposable test channel).
"""

import base64
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import http.client
import json
import os
import re
import secrets
import shlex
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

BASE = os.getenv("CLIPS_TEST_ORIGIN", "http://localhost:8787")
assert urlsplit(BASE).hostname in ("localhost", "127.0.0.1")
FAKE = "http://127.0.0.1:9393"
CHANNEL = "UC-local-testing"
PREFIX = "https://www.googleapis.com/auth/youtube."
codes, tokens, sessions, videos = {}, {}, {}, {}
grants = set()
quota = False
revoked = False
reads = []
stale_reads = {}
processing_result = "processed"
list_gate = threading.Event()
list_gate.set()
failures = []


def check(ok, label):
    print(f"{'OK' if ok else 'FAIL'}: {label}", flush=True)
    if not ok:
        failures.append(label)


def sql(statement, args=()):
    # Only touch the disposable Wrangler database used by this exercise.
    files = [
        p
        for p in Path("web/.wrangler/state/v3/d1").rglob("*.sqlite")
        if p.name != "metadata.sqlite"
    ]
    assert len(files) == 1, files
    with sqlite3.connect(files[0]) as db:
        return db.execute(statement, args).fetchall()


def digest(value):
    return (
        base64.urlsafe_b64encode(hashlib.sha256(value.encode()).digest())
        .decode()
        .rstrip("=")
    )


class Google(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # OAuth codes and resumable URLs are credentials.

    def reply(self, code=200, data=None, **headers):
        payload = json.dumps(data).encode() if data is not None else b""
        self.send_response(code)
        for key, value in headers.items():
            self.send_header(key, value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def handle_request(self):
        global revoked
        p = urlsplit(self.path)
        q = {k: v[0] for k, v in parse_qs(p.query).items()}
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        if p.path == "/o/oauth2/v2/auth":
            assert (
                q["client_id"] == "test-client" and q["code_challenge_method"] == "S256"
            )
            assert q["redirect_uri"] == BASE + "/api/youtube/callback"
            code = secrets.token_hex()
            codes[code] = q
            return self.reply(
                302,
                Location=q["redirect_uri"]
                + "?"
                + urlencode(dict(code=code, state=q["state"])),
            )
        if p.path in ("/token", "/revoke"):
            f = {k: v[0] for k, v in parse_qs(body.decode()).items()}
            if p.path == "/revoke":
                assert f["token"] == "testing-refresh"
                revoked = True
                return self.reply(200, {})
            assert f["client_secret"] == "test-secret"
            fresh = f["grant_type"] == "authorization_code"
            if fresh:
                req = codes.pop(f["code"])
                assert f["redirect_uri"] == req["redirect_uri"]
                assert (
                    base64.urlsafe_b64encode(
                        hashlib.sha256(f["code_verifier"].encode()).digest()
                    )
                    .decode()
                    .rstrip("=")
                    == req["code_challenge"]
                )
                grants.update(req["scope"].split())
                revoked = False
            elif revoked or f.get("refresh_token") != "testing-refresh":
                return self.reply(400, {"error": "invalid_grant"})
            token = secrets.token_hex()
            tokens[token] = grants.copy()
            data = {"access_token": token, "scope": " ".join(grants)}
            if fresh:
                data["refresh_token"] = "testing-refresh"
            return self.reply(200, data)
        if p.path.startswith("/session/"):
            assert self.command == "PUT"
            s = sessions[p.path]
            rg = self.headers["content-range"]
            auth = self.headers.get("Authorization")
            if auth:
                assert (
                    rg.startswith("bytes */")
                    and s.get("id")
                    and auth.removeprefix("Bearer ") in tokens
                )
                s["verified"] = True
            if rg == f"bytes */{s['size']}":
                assert not body
                s["queries"].append(len(s["data"]))
                if s.get("id"):
                    return self.reply(200, {"id": s["id"]})
                return (
                    self.reply(308, Range=f"bytes=0-{len(s['data']) - 1}")
                    if s["data"]
                    else self.reply(308)
                )
            start, end, total = map(
                int, re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", rg).groups()
            )
            assert total == s["size"] and end - start + 1 == len(body)
            if start != len(s["data"]):
                return self.reply(409, {"error": "Query the session before retrying"})
            if not start and len(body) > 256 * 1024:
                s["data"].extend(body[: 256 * 1024])
            else:
                s["data"].extend(body)
                if end + 1 < total:
                    return self.reply(308, Range=f"bytes=0-{end}")
                s["id"] = f"test{len(sessions):07d}"
                videos[s["id"]] = dict(
                    id=s["id"],
                    snippet={
                        **s["meta"]["snippet"],
                        "channelId": CHANNEL,
                        "thumbnails": {"high": {"url": "https://example.com/test.jpg"}},
                    },
                    status={**s["meta"]["status"], "uploadStatus": "uploaded"},
                    contentDetails={"duration": "PT13S"},
                )
            # Lose one partially received request AND the final successful reply.
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        access = tokens.get(
            self.headers.get("authorization", "").removeprefix("Bearer ")
        )
        if not access or revoked:
            return self.reply(401, {})
        if p.path == "/oauth2/v3/userinfo":
            return self.reply(
                200, {"sub": "local-subject", "email": "test@example.org"}
            )
        if p.path == "/youtube/v3/channels":
            return self.reply(
                200, {"items": [{"id": CHANNEL, "snippet": {"title": "Local channel"}}]}
            )
        if p.path == "/upload/youtube/v3/videos":
            if quota:
                return self.reply(
                    403, {"error": {"errors": [{"reason": "quotaExceeded"}]}}
                )
            assert PREFIX + "upload" in access and q["uploadType"] == "resumable"
            key = "/session/" + secrets.token_hex(12)
            sessions[key] = {
                "size": int(self.headers["x-upload-content-length"]),
                "meta": json.loads(body),
                "data": bytearray(),
                "queries": [],
            }
            return self.reply(200, Location=FAKE + key)
        if p.path == "/youtube/v3/videos":
            if self.command == "GET":
                assert PREFIX + "readonly" in access
                reads.append(q["id"])
                assert list_gate.wait(10), "library polls blocked on Google"
                if reads.count(q["id"]) >= 2 and q["id"] in videos:
                    videos[q["id"]]["status"]["uploadStatus"] = processing_result
                items = []
                for i in q["id"].split(","):
                    if i in videos:
                        items.append(
                            stale_reads[i].pop() if stale_reads.get(i) else videos[i]
                        )
                return self.reply(200, {"items": items})
            assert PREFIX + "force-ssl" in access
            if self.command == "DELETE":
                del videos[q["id"]]
                return self.reply(204)
            v = json.loads(body)
            stale_reads[v["id"]] = [copy.deepcopy(videos[v["id"]])] * 2
            for part in q["part"].split(","):
                videos[v["id"]][part].update(v[part])
            return self.reply(200, videos[v["id"]])
        self.reply(404)

    do_GET = do_POST = do_DELETE = do_PUT = handle_request


cookies = {}


def call(path, method="GET", data=None, status=200, bearer=None, origin=None):
    u = urlsplit(path if path.startswith("http") else BASE + path)
    assert u.hostname in ("localhost", "127.0.0.1")
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=20)
    headers = {"content-type": "application/json"}
    if origin:
        headers["Origin"] = origin
    if u.port == urlsplit(BASE).port:
        headers["cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    if bearer:
        headers["authorization"] = "Bearer " + bearer
    conn.request(
        method,
        u.path + ("?" + u.query if u.query else ""),
        json.dumps(data) if method != "GET" else None,
        headers,
    )
    r = conn.getresponse()
    if status is None:
        r.read()
        return r.status
    assert r.status == status, (u.path, r.status, r.read())
    if u.port == urlsplit(BASE).port:
        for name, val in r.getheaders():
            if name.lower() == "set-cookie":
                cookies.update({k: v.value for k, v in SimpleCookie(val).items()})
    raw = r.read()
    return (
        r.getheader("location") if status == 302 else json.loads(raw) if raw else None
    )


def login(purpose, pair=False):
    verifier = secrets.token_urlsafe(32)
    auth = call(
        "/api/youtube/connect?purpose="
        + purpose
        + (
            "&obs_port=12345&obs_state=test-state&obs_challenge=" + digest(verifier)
            if pair
            else ""
        ),
        status=302,
    )
    scopes = parse_qs(urlsplit(auth).query)["scope"][0].split()
    assert (PREFIX + "force-ssl" in scopes) == (purpose == "manage")
    result = call(call(auth, status=302), status=302)
    if not pair:
        assert result == "/", result
        return
    u = urlsplit(result)
    assert (u.hostname, u.port, u.path) == ("127.0.0.1", 12345, "/callback"), result
    query = parse_qs(u.query)
    assert query["state"] == ["test-state"]
    exchange = {"code": query["code"][0], "verifier": verifier}
    call(
        "/api/youtube/obs/exchange",
        "POST",
        {**exchange, "verifier": secrets.token_urlsafe(32)},
        401,
    )
    token = call("/api/youtube/obs/exchange", "POST", exchange)["uploadToken"]
    call("/api/youtube/obs/exchange", "POST", exchange, status=401)
    return token


def exercise():
    global quota, revoked, processing_result
    scratch = Path(".amp/in/orb-backup/youtube-test")
    scratch.mkdir(exist_ok=True, parents=True)
    probe = scratch / "upload-probe"
    compiler = shlex.split(
        subprocess.check_output(
            ["pkg-config", "--cflags", "--libs", "Qt6Network", "libobs"], text=True
        )
    )
    subprocess.run(
        [
            "c++",
            "-std=c++17",
            "-fPIC",
            "-Isrc",
            "web/worker/tests/upload-probe.cpp",
            "src/youtube-upload.cpp",
            "-o",
            str(probe),
            *compiler,
        ],
        check=True,
    )
    mp4 = scratch / "clip.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=24",
            "-t",
            "13",
            "-c:v",
            "mpeg4",
            "-q:v",
            "4",
            str(mp4),
        ],
        check=True,
    )
    sid = secrets.token_urlsafe(32)
    user = "fixture-" + secrets.token_hex(8)
    sql("INSERT INTO users VALUES(?,?,0)", (user, "fixture@example.org"))
    sql(
        "INSERT INTO sessions VALUES(?,?,?)",
        (digest(sid), user, int(time.time() * 1000) + 600000),
    )
    cookies["clips_sid"] = sid
    token = login("pair", True)
    check(
        cookies["clips_sid"] == sid
        and sql("SELECT user_id FROM youtube_accounts WHERE user_id=?", (user,)),
        "pair binds existing browser session",
    )
    check(
        call("/api/youtube/disconnect", "POST", {}, status=None) == 403,
        "cookie disconnect requires a trusted Origin",
    )
    call(
        "/api/youtube/disconnect",
        "POST",
        {},
        status=403,
        origin="https://other.example",
    )
    assert not revoked
    call("/api/youtube/disconnect", "POST", {}, origin=BASE)
    assert revoked
    cookies.clear()
    token = login("pair", True)
    slow = call(
        "/api/youtube/upload/start",
        "POST",
        dict(
            title="slow",
            description="",
            privacy="private",
            size=1,
            category="",
            recordedAt="2026-11-01",
        ),
        bearer=token,
    )
    sql("UPDATE youtube_clips SET uploaded='2020-01-01' WHERE id=?", (slow["clipId"],))
    sessions[urlsplit(slow["sessionUrl"]).path]["id"] = "missing0001"
    complete = dict(clipId=slow["clipId"], videoId="missing0001")
    call("/api/youtube/upload/complete", "POST", complete, bearer=token)
    call("/api/youtube/upload/status?clipId=" + slow["clipId"], bearer=token)
    check(
        sql("SELECT id FROM youtube_clips WHERE id=?", (slow["clipId"],)),
        "first miss after a slow upload keeps its row",
    )
    clock = sql("SELECT uploaded FROM youtube_clips WHERE id=?", (slow["clipId"],))
    assert clock and clock != [("2020-01-01",)]
    call("/api/youtube/upload/complete", "POST", complete, bearer=token)
    assert (
        sql("SELECT uploaded FROM youtube_clips WHERE id=?", (slow["clipId"],)) == clock
    )
    sql("DELETE FROM youtube_clips WHERE id=?", (slow["clipId"],))
    check(
        call(
            "/api/youtube/connect?purpose=login&obs_port=12345&obs_state=test",
            status=None,
        )
        == 400,
        "OBS pairing requires a challenge",
    )
    me = call("/api/me")
    assert (
        me["storage"] is None
        and me["youtube"]["channelId"] == CHANNEL
        and not me["youtube"]["canManage"]
    )
    assert call("/api/clips") == {"clips": [], "youtube": []}
    print("Bucketless Google login, OBS state and single-use exchange: OK", flush=True)

    def upload():
        n = len(sessions)
        p = subprocess.run(
            [str(probe), BASE, str(mp4)],
            text=True,
            input=token + "\n",
            capture_output=True,
            timeout=45,
        )
        assert p.returncode == 0, (p.stdout, p.stderr)
        assert len(sessions) == n + 1
        s = list(sessions.values())[-1]
        assert (
            s["data"] == mp4.read_bytes()
            and 262144 in s["queries"]
            and s["size"] in s["queries"]
        )
        assert p.stdout.strip() == "https://youtu.be/" + s["id"]
        check(s.get("verified"), "Worker receipt carries a Google bearer")
        toast = (
            "is ready to play"
            if processing_result == "processed"
            else "could not process"
        )
        assert p.stderr.index("Uploader released") < p.stderr.index(toast)
        assert reads.count(s["id"]) == 2
        print(
            f"Processing: uploader returned before two status checks and '{toast}' toast"
        )
        print(
            f"One session, one video, {s['size']} identical bytes, status queries at {s['queries']}; no bearer on OBS PUT",
            flush=True,
        )
        return s["id"]

    vid = upload()
    initial = (len(tokens), len(reads))
    for _ in range(3):
        call("/api/clips")
    check(
        initial == (len(tokens), len(reads)),
        "ready polls use D1 without refreshing or listing",
    )
    list_gate.clear()
    try:
        sql("UPDATE youtube_clips SET nextSync=0 WHERE videoId=?", (vid,))
        with ThreadPoolExecutor(4) as pool:
            for reply in pool.map(call, ["/api/clips"] * 4):
                assert reply["youtube"][0]["status"] == "ready"
        for _ in range(100):
            if len(reads) > initial[1]:
                break
            time.sleep(0.01)
        assert (len(tokens), len(reads)) == (initial[0] + 1, initial[1] + 1)
        print(
            "Four concurrent polls returned cached rows during one blocked Google read"
        )
    finally:
        list_gate.set()
    clip = call("/api/clips")["youtube"][0]
    assert (
        clip["videoId"] == vid
        and clip["title"] == "Game α"
        and clip["status"] == "ready"
        and clip["durationSeconds"] == 13
    )
    endpoint = "/api/youtube/clips/" + clip["id"]
    assert call(endpoint, "PATCH", {"title": "No grant"}, 403)["needs"] == "manage"
    login("manage")
    call(
        endpoint,
        "PATCH",
        {"title": "New title", "privacy": "private", "description": "New description"},
    )
    assert (
        videos[vid]["snippet"]["title"] == "New title"
        and videos[vid]["status"]["privacyStatus"] == "private"
    )

    def metadata():
        row = call("/api/clips")["youtube"][0]
        return row["title"], row["description"], row["privacy"]

    actual = metadata()
    assert actual == ("New title", "New description", "private"), actual
    time.sleep(5.3)
    call(endpoint, "PATCH", {"description": "Second edit"})
    check(
        videos[vid]["snippet"]["title"] == "New title",
        "delayed description edit preserves rename",
    )

    def sync_due():
        # Advance just this row's schedule; the request still runs the real sync.
        sql("UPDATE youtube_clips SET nextSync=0 WHERE videoId=?", (vid,))
        call("/api/clips")
        for _ in range(200):
            row = sql("SELECT nextSync FROM youtube_clips WHERE videoId=?", (vid,))
            if not row or (
                row[0][0] and abs(row[0][0] - time.time() * 1000 - 60000) > 2000
            ):
                return
            time.sleep(0.02)
        raise AssertionError("background sync did not finish")

    for _ in range(3):
        sync_due()
        actual = metadata()
        assert actual == ("New title", "Second edit", "private"), actual
    assert not stale_reads[vid]
    print("Repeated stale reads and a description-only follow-up PATCH: OK")
    call(endpoint + "/cut", "PUT", {"start": 2.5, "end": 7}, 400)
    call(endpoint + "/cut", "PUT", {"start": 2, "end": 7})
    assert call("/api/clips")["youtube"][0]["cut"] == {"start": 2, "end": 7}
    call(endpoint + "/cut", "PUT", None)
    videos[vid]["snippet"]["title"] = "Renamed on YouTube"
    videos[vid]["status"]["privacyStatus"] = "unlisted"
    sync_due()
    assert metadata() == ("Renamed on YouTube", "Second edit", "unlisted")
    print("Studio rename and visibility on the next scheduled sync: OK")
    with ThreadPoolExecutor(2) as pool:
        list(
            pool.map(
                lambda payload: call(endpoint, "PATCH", payload),
                [{"title": "Concurrent"}, {"description": "Independent"}],
            )
        )
    assert metadata() == ("Concurrent", "Independent", "unlisted")
    assert (
        videos[vid]["snippet"]["title"] == "Concurrent"
        and videos[vid]["snippet"]["description"] == "Independent"
    )
    sync_due()  # Finish the post-edit refresh before making the video disappear.
    del videos[vid]
    sql("UPDATE youtube_clips SET uploaded='2020-01-01' WHERE videoId=?", (vid,))
    sync_due()
    assert call("/api/clips")["youtube"]
    sync_due()
    assert call("/api/clips")["youtube"] == []
    processing_result = "failed"
    vid = upload()
    clip = call("/api/clips")["youtube"][0]
    call("/api/youtube/clips/" + clip["id"], "DELETE")
    assert vid not in videos and not call("/api/clips")["youtube"]
    print(
        "Manage grant, rename, visibility, cut, delete, external rename/deletion: OK",
        flush=True,
    )
    metadata = {
        "title": "Replay",
        "description": "",
        "privacy": "unlisted",
        "size": 123,
        "category": "Game",
        "recordedAt": "2026-11-25T00:00:00Z",
    }
    quota = True
    assert (
        "limit"
        in call("/api/youtube/upload/start", "POST", metadata, 403, token)["error"]
    )
    quota = False
    call("/api/youtube/disconnect", "POST", {}, bearer=token)
    assert revoked and call("/api/me")["youtube"] is None
    call("/api/youtube/upload/start", "POST", metadata, 401, token)
    token = login("connect", True)
    revoked = True
    assert (
        "Sign in"
        in call("/api/youtube/upload/start", "POST", metadata, 401, token)["error"]
        and call("/api/me")["youtube"] is None
    )
    print(
        "Quota error, disconnect revocation, reconnect and external revocation cleanup: OK"
    )
    assert not failures, failures


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 9393), Google)
    if "--serve" in sys.argv:
        server.serve_forever()
    else:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            exercise()
        finally:
            server.shutdown()
            server.server_close()
