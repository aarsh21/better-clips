---
name: verify-better-clips
description: Verifies Better Clips in real OBS and Chromium against local Google and D1 fixtures. Use for replay capture, YouTube sign-in, upload, secure storage, player restrictions and release checks.
---

# Verify Better Clips

Run from the root of a disposable Linux x86-64 checkout in an Amp orb. The lab needs an unused Xvfb display `:97`, ports 8787, 9229 and 9393, no running OBS and no existing `web/.dev.vars` or `web/.wrangler/state`. Do not publish a portal for the fakes. Load `using-agent-browser` before driving Chromium.

```bash
.agents/setup
sudo -n apt-get update -qq
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  obs-studio qt6-svg-plugins xvfb xdotool openbox xclip x11-utils x11-xserver-utils libgl1-mesa-dri sqlite3 \
  python3-pyatspi at-spi2-core dbus-x11 gnome-keyring libsecret-tools ffmpeg imagemagick iptables jq
S=$PWD/.agents/skills/verify-better-clips/scripts
id=$(date +%s | tail -c 9)
E=$PWD/.amp/in/artifacts/bc-$id
"$S/lab" start "$id"
```

`start` builds the dashboard, migrates disposable local D1, starts the Worker and unlocks a private Secret Service on the lab's D-Bus. The Worker and fake share ephemeral test credentials. Never point either at a live service. Keep the lab running across the following chapters; the browser session, OAuth callback and OBS profile belong to the same run ID.

```bash
set -e
"$S/lab" doctor "$id"
"$S/lab" protocol "$id"
for chapter in install channel player edit direct credentials; do
  "$S/drive" "$chapter" "$id"
done
"$S/lab" gates "$id"
```

- `protocol` exercises both actual upload transports, OAuth scopes, consent, default and overridden audience, interrupted uploads, byte identity and status reads. It also runs the [no-Qt-TLS probe](features/transport.md) before starting the interactive fake on the same port.
- `install` builds the current plugin with warnings as errors and the fake desktop client, packages and installs it in the lab's private OBS profile. It dismisses the OBS wizard, loads a calibration reel and checks that the first dock action is **Connect YouTube**. Also build a separate tree with `-DYOUTUBE_CLIENT_ID= -DYOUTUBE_CLIENT_SECRET=` for releases.
- `channel` signs into `/apps/` through the disclosure, pairs two independent real OBS identities, unpairs each way and reconnects. It checks the settings disclosure, Yes/No menu and form at 1440×900 and 1366×768. A dock upload must become ready with the default No. Match the clipboard link to the row, and ffprobe the same local MP4 after readiness.
- `player` varies Google's reported audience. For kids and unknown, require a watch link and no iframe or iframe API script. Only confirmed not-for-kids clips get an embed. The fake has no playable YouTube ID or live thumbnail: the gray frame tests eligibility, **not playback**.
- `edit` exercises metadata, not video editing: rename, change visibility, wait for Google confirmation, check **Edit — coming soon** is disabled and **Download** targets this video's Studio edit URL. Then confirm deletion and disconnect. Never follow the Studio link in the fake lab.
- `direct` presses the OBS hotkey, reviews an upload, verifies the direct link, persistent local MP4, private keyring entry and absence of a hosted library row, then disconnects. `credentials` checks token scrubbing from config and backup, restart with the keyring, invalid-grant cleanup and the one-time session-only notice without a keyring. Never export configs, pairing URLs or keyring data.
- `length` is a separate capture test: after `channel` on a fresh run, save with two encoder profiles. Check the keyframe-aligned window, warning count and dock recovery. It creates more clips, so do not run it before `player` or `edit` in the same library.
- `gates` checks clang-format 19, gersemi on changed CMake files, `pnpm --dir web check` (React Doctor 100/100) and the production build. Set `BC_FORMAT_BASE` to the release base when it differs from `origin/main`.

For a failure, inspect `amp orb service logs bc-$id-host`, `DISPLAY=:97 "$S/obs-ui"` and `agent-browser --session "yt-$id" snapshot -i`. Capture dark and light using the dashboard theme button and OBS Settings → Appearance → Style. Inspect the resulting media in `$E`; a toast alone does not verify upload bytes or readiness. Native macOS/Windows packaging, live Google playback and real Studio downloading are outside this lab.

Run `"$S/lab" stop "$id"` even after a failure. It removes this run's services, secrets, state links and firewall rule but keeps `$E`.
