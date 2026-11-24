#!/bin/sh
# Installs Replay to R2 for OBS on macOS or Linux and connects it to your
# clips app. Copy the command from your app (Settings > OBS), or run:
#
#   curl -fsSL https://raw.githubusercontent.com/aarsh21/obs-replay-r2/main/install.sh | sh -s -- '<setup code>'
#
# Without a setup code it only installs the plugin. Nothing needs sudo.
set -eu

REPO="aarsh21/obs-replay-r2"
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
	macos) ASSET="obs-replay-r2-$VERSION-macos-universal.pkg" ;;
	linux) ASSET="obs-replay-r2-$VERSION-x86_64-linux-gnu.deb" ;;
	esac
	say "Downloading Replay to R2 $VERSION..."
	PACKAGE="$TMP/$ASSET"
	curl -fsSL -o "$PACKAGE" "https://github.com/$REPO/releases/download/$VERSION/$ASSET" ||
		fail "Could not download $ASSET."
fi

if [ "$OS" = macos ]; then
	# The package installs into ~/Library, so it needs no password.
	say "Installing the plugin..."
	installer -pkg "$PACKAGE" -target CurrentUserHomeDirectory >/dev/null ||
		fail "The installer failed."
	PLUGIN="$OBS_CONFIG/plugins/obs-replay-r2.plugin"
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
	SO=$(find "$TMP/deb" -path '*/obs-plugins/obs-replay-r2.so' | head -n 1)
	LOCALE=$(find "$TMP/deb" -path '*/obs-plugins/obs-replay-r2/locale' -type d | head -n 1)
	[ -n "$SO" ] || fail "The package has no plugin in it."

	PLUGIN="$OBS_CONFIG/plugins/obs-replay-r2"
	mkdir -p "$PLUGIN/bin/64bit" "$PLUGIN/data"
	# Copy, then rename, so a crashed copy never leaves half a plugin.
	cp "$SO" "$PLUGIN/bin/64bit/.obs-replay-r2.so.new"
	mv -f "$PLUGIN/bin/64bit/.obs-replay-r2.so.new" "$PLUGIN/bin/64bit/obs-replay-r2.so"
	if [ -n "$LOCALE" ]; then
		rm -rf "$PLUGIN/data/locale"
		cp -R "$LOCALE" "$PLUGIN/data/locale"
	fi

	MISSING=$(ldd "$PLUGIN/bin/64bit/obs-replay-r2.so" 2>/dev/null | awk '/not found/ {print $1}' | tr '\n' ' ')
	if [ -n "$MISSING" ]; then
		say "Warning: these libraries are missing, so OBS may not load the plugin: $MISSING"
	fi
	for old in /usr/lib/*/obs-plugins/obs-replay-r2.so /usr/lib/obs-plugins/obs-replay-r2.so; do
		if [ -e "$old" ]; then
			say "Warning: another copy is installed at $old. Remove it with: sudo apt remove obs-replay-r2"
		fi
	done
fi

if [ -n "$CODE" ]; then
	# The plugin reads this on OBS's next start, then deletes it.
	DIR="$OBS_CONFIG/plugin_config/obs-replay-r2"
	mkdir -p "$DIR"
	(umask 077 && printf '%s' "$CODE" >"$DIR/setup-code.txt")
fi

say "Installed to $PLUGIN"
if [ -n "$CODE" ]; then
	say "When OBS opens, it connects to your clips app and starts the Replay Buffer."
	say "Press Ctrl+Alt+R to save a replay (change it in Settings > Hotkeys)."
else
	say "In OBS, open Tools > Replay to R2 Settings and paste the setup code from your clips app."
fi

# Open OBS, if this is a desktop session.
if [ "$OS" = macos ]; then
	open -a OBS 2>/dev/null || say "Open OBS to finish."
elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v obs >/dev/null; then
	(nohup obs >/dev/null 2>&1 &)
else
	say "Open OBS to finish."
fi
