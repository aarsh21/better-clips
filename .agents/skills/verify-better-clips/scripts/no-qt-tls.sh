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
    auto response = youtube_http::perform({QUrl("https://www.googleapis.com/oauth2/v3/userinfo")}, false);
    std::printf("Qt supports TLS: %d; plugin HTTPS: %s\n", ssl, response.diagnostic().c_str());
    return ssl || response.code != CURLE_OK || response.status != 401;
}
CPP
env -u QT_PLUGIN_PATH "$d/check"
