#!/bin/sh
# Installs Better Clips for OBS on macOS or Linux and connects it to your
# clips app. Copy the command from your app (Settings > OBS), or run:
#
#   curl -fsSL https://raw.githubusercontent.com/aarsh21/better-clips/main/install.sh | sh -s -- '<setup code>'
#
# Without a setup code it only installs the plugin. Only removing an old
# system-wide install may need sudo.
set -eu

REPO="aarsh21/better-clips"
CODE="${1:-${CLIPS_SETUP_CODE:-}}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() {
	printf '\033[31mError:\033[0m %s\n' "$*" >&2
	exit 1
}

case "$CODE" in
"" | r2obs1:* | r2obs2:*) ;;
*) fail "That doesn't look like a setup code. Copy it again from Settings > OBS in your clips app." ;;
esac

if [ -n "$CODE" ]; then
	command -v python3 >/dev/null || fail 'Validating a setup code requires Python 3. You can also install without the code and paste it in OBS.'
	printf '%s' "$CODE" | python3 -c '
import base64, json, sys, urllib.parse
try:
    prefix, payload = sys.stdin.read().split(":", 1)
    data = json.loads(base64.b64decode(payload, validate=True).decode("utf-8"))
    app = prefix == "r2obs2"
    keys = ("a", "t") if app else ("u", "k", "s")
    valid = all(isinstance(data.get(k), str) and data[k].strip() for k in keys)
    url = urllib.parse.urlsplit(data[keys[0]].strip())
    valid = valid and url.hostname and url.username is None and not url.query and not url.fragment and (app or url.path.strip("/")) and (url.scheme == "https" or (url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost") and url.port))
except (TypeError, ValueError, KeyError, AttributeError):
    valid = False
sys.exit(0 if valid else 1)
' || fail 'Invalid setup code. Copy a fresh setup code from your Better Clips app.'
fi

command -v curl >/dev/null || fail "curl is required."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

case "$(uname -s)" in
Darwin)
	OS=macos
	OBS_CONFIG="$HOME/Library/Application Support/obs-studio"
	OBS_PROCESS=OBS
	;;
Linux)
	OS=linux
	OBS_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/obs-studio"
	OBS_PROCESS=obs
	if ! command -v obs >/dev/null && command -v flatpak >/dev/null &&
		flatpak info com.obsproject.Studio >/dev/null 2>&1; then
		fail "The Flatpak version of OBS isn't supported yet. Install OBS from your distribution or the OBS PPA."
	fi
	[ "$(uname -m)" = x86_64 ] || fail "Only x86_64 Linux is supported."
	;;
*) fail "Use install.ps1 on Windows." ;;
esac

# The plugin replaces files OBS has open, so OBS must be closed.
if pgrep -x "$OBS_PROCESS" >/dev/null 2>&1; then
	say "Close OBS to continue. Waiting for it to quit..."
	while pgrep -x "$OBS_PROCESS" >/dev/null 2>&1; do sleep 1; done
fi

# OBS_R2_PACKAGE installs a local package instead, for testing.
if [ -n "${OBS_R2_PACKAGE:-}" ]; then
	PACKAGE="$OBS_R2_PACKAGE"
else
	TAG=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")
	VERSION=${TAG##*/}
	case "$OS" in
	macos) ASSET="better-clips-$VERSION-macos-universal.pkg" ;;
	linux) ASSET="better-clips-$VERSION-x86_64-linux-gnu.deb" ;;
	esac
	say "Downloading Better Clips $VERSION..."
	PACKAGE="$TMP/$ASSET"
	curl -fsSL -o "$PACKAGE" "https://github.com/$REPO/releases/download/$VERSION/$ASSET" ||
		fail "Could not download $ASSET."
fi

if [ "$OS" = macos ]; then
	# The package installs into ~/Library, so it needs no password.
	say "Installing the plugin..."
	installer -pkg "$PACKAGE" -target CurrentUserHomeDirectory >/dev/null ||
		fail "The installer failed."
	PLUGIN="$OBS_CONFIG/plugins/better-clips.plugin"
	[ -d "$PLUGIN" ] || fail "The plugin wasn't installed to $PLUGIN."
else
	# OBS loads plugins from ~/.config/obs-studio/plugins too, so unpack the
	# .deb there instead of installing it system-wide.
	say "Installing the plugin..."
	mkdir -p "$TMP/deb"
	if command -v dpkg-deb >/dev/null; then
		dpkg-deb -x "$PACKAGE" "$TMP/deb"
	elif command -v ar >/dev/null; then
		(cd "$TMP/deb" && ar x "$PACKAGE" && tar -xf data.tar.*)
	elif command -v bsdtar >/dev/null; then
		(cd "$TMP/deb" && bsdtar -xf "$PACKAGE" && tar -xf data.tar.*)
	else
		fail "Need dpkg-deb, ar or bsdtar to unpack the plugin."
	fi
	SO=$(find "$TMP/deb" -path '*/obs-plugins/better-clips.so' | head -n 1)
	LOCALE=$(find "$TMP/deb" -path '*/obs-plugins/better-clips/locale' -type d | head -n 1)
	[ -n "$SO" ] || fail "The package has no plugin in it."

	PLUGIN="$OBS_CONFIG/plugins/better-clips"
	# Stage and keep the previous version outside OBS's module search path.
	mkdir -p "$OBS_CONFIG/plugins" "$OBS_CONFIG/plugin-backups"
	STAGE=$(mktemp -d "$OBS_CONFIG/plugin-backups/staged.XXXXXX")
	trap 'rm -rf "$TMP" "$STAGE"' EXIT
	mkdir -p "$STAGE/bin/64bit" "$STAGE/data"
	cp "$SO" "$STAGE/bin/64bit/better-clips.so"
	[ -s "$LOCALE/en-US.ini" ] && [ -n "$LOCALE" ] || fail 'The package is missing its locale.'
	cp -R "$LOCALE" "$STAGE/data/locale"
	DEPS=$(LC_ALL=C ldd "$STAGE/bin/64bit/better-clips.so") || fail 'Cannot load the staged Linux plugin.'
	case "$DEPS" in *'not found'*) fail "Missing plugin libraries: $(printf '%s\n' "$DEPS" | awk '/not found/{print $1}')";; esac
	nm -D --defined-only "$STAGE/bin/64bit/better-clips.so" | grep -q ' obs_module_load$' || fail 'The package does not contain a loadable OBS module (requires nm).'
	BACKUP="$OBS_CONFIG/plugin-backups/better-clips"
	if [ -e "$PLUGIN" ]; then
		rm -rf "$BACKUP"
		mv "$PLUGIN" "$BACKUP"
	fi
	if ! mv "$STAGE" "$PLUGIN"; then
		[ ! -d "$BACKUP" ] || mv "$BACKUP" "$PLUGIN"
		fail 'Could not install the staged plugin.'
	fi
	rm -rf "$OBS_CONFIG/plugins/obs-replay-r2"
	as_root() {
		if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
	}
	if [ "$(dpkg-query -W -f='${db:Status-Status}' obs-replay-r2 2>/dev/null || :)" = installed ]; then
		say "Removing the old system-wide plugin..."
		as_root dpkg --remove obs-replay-r2
	fi
	for prefix in /usr /usr/local; do
		for old in "$prefix"/lib/*/obs-plugins/obs-replay-r2.so "$prefix/lib/obs-plugins/obs-replay-r2.so" \
			"$prefix/share/obs/obs-plugins/obs-replay-r2"; do
			[ ! -e "$old" ] || as_root rm -rf -- "$old"
		done
	done
fi

if [ -n "$CODE" ]; then
	# The plugin reads this on OBS's next start, then deletes it.
	DIR="$OBS_CONFIG/plugin_config/better-clips"
	mkdir -p "$DIR"
	(umask 077 && pending=$(mktemp "$DIR/setup-code.XXXXXX") && printf '%s' "$CODE" >"$pending" && mv -f "$pending" "$DIR/setup-code.txt")
fi

say "Installed to $PLUGIN"
if [ -n "$CODE" ]; then
	say "When OBS opens, it connects to your clips app and starts the Replay Buffer."
	say "Press Ctrl+Alt+R to save a replay (change it in Settings > Hotkeys)."
else
	say "In OBS, open Tools > Better Clips Settings and choose YouTube, an S3 bucket, or your Better Clips app."
fi

# Open OBS, if this is a desktop session.
if [ "$OS" = macos ]; then
	open -a OBS 2>/dev/null || say "Open OBS to finish."
elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v obs >/dev/null; then
	(nohup obs >/dev/null 2>&1 &)
else
	say "Open OBS to finish."
fi
