#!/usr/bin/env bash
# Compile the plugin's actual HTTP transport against a private Qt plugin tree.
set -eu
root=$(git rev-parse --show-toplevel)
d=${R:?}/no-tls
mkdir -p "$d/plugins"
qt=$(qmake6 -query QT_INSTALL_PLUGINS)
for p in "$qt"/*; do [[ ${p##*/} == tls ]] || ln -sfn "$p" "$d/plugins/"; done
printf '[Paths]\nPlugins=%s/plugins\n' "$d" >"$d/qt.conf"
c++ -std=c++17 -fPIC -I"$root/src" -x c++ - "$root/src/youtube-http.cpp" $(pkg-config --cflags --libs Qt6Network libcurl) -o "$d/check" <<'CPP'
#include "youtube-http.hpp"
#include <QCoreApplication>
#include <QSslSocket>
#include <cstdio>
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    bool ssl = QSslSocket::supportsSsl();
    auto response = youtube_http::perform({QUrl(argv[1])}, false);
    std::printf("Qt supports TLS: %d; plugin HTTPS: %s\n", ssl, response.diagnostic().c_str());
    return ssl || response.code != CURLE_OK || response.status != 401;
}
CPP
# Trust a disposable loopback certificate only in the probe's mount namespace.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -addext subjectAltName=IP:127.0.0.1 \
  -keyout "$d/key" -out "$d/cert" 2>/dev/null
python3 - "$d" <<'PY'
import os, ssl, subprocess, sys, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

d = sys.argv[1]
class Fake(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(401)
        self.send_header('Content-Length', '0')
        self.end_headers()

with HTTPServer(('127.0.0.1', 0), Fake) as server:
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(d+'/cert', d+'/key')
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.handle_request, daemon=True).start()
    subprocess.run(['sudo', '-n', 'unshare', '-m', '--propagation', 'private', 'sh', '-ec',
        'mount --bind "$1/cert" "$2"; exec runuser -u "$3" -- env -u QT_PLUGIN_PATH "$1/check" "$4"',
        'sh', d, subprocess.check_output(['curl-config', '--ca'], text=True).strip(),
        os.environ['USER'], f'https://127.0.0.1:{server.server_port}/userinfo'], check=True)
PY
