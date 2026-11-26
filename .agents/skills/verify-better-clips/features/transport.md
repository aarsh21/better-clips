# Recover uploads and work without Qt TLS

## Sub-features

Successful and rejected processing; partial uploads and lost final responses; retries, consent and revocation; the macOS Qt-without-TLS failure condition.

## How to get to it (user POV)

Save to either YouTube route. The first message supplies a link while YouTube processes the clip. The later message says ready or failed without copying over the user's clipboard again.

## Driving it with the protocol exercise

Before starting the interactive fake, capture `"$S/lab" doctor "$id"` and the signed-out `/api/me` state. `"$S/lab" protocol "$id"` drives both real plugin transports through the hosted Worker and fake Google using a generated MP4. The fake checks bytes and range queries; the probe checks uploader release precedes the ready/failed notification. A separate C++ probe beside a private `qt.conf` excludes Qt's TLS plugins and first measures `QSslSocket::supportsSsl()`. It calls the plugin's actual `youtube_http::perform` over HTTPS with **no credentials**. Inspect `$E/protocol.log` and `$E/no-qt-tls.log`: the latter must contain both `Qt supports TLS: 0` and `plugin HTTPS: HTTP 401` (TLS succeeded; authentication did not). Pair these with the OBS notifications captured by the YouTube chapters.

## Gotchas

The protocol exercise compiles a test client; it does not drive OBS or the real Google player. The TLS probe uses a loopback HTTPS server and a disposable certificate trusted only inside the probe's private mount namespace. Neither Google's endpoint nor a global trust-store change is needed. A Linux check is not native macOS verification.
