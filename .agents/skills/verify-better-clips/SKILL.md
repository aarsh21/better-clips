---
name: verify-better-clips
description: Verifies Better Clips changes end to end in real OBS and the web dashboard. Use for replay capture, uploads, pairing, clip edits, installer upgrades, Qt TLS regressions and release checks.
---

# Verify Better Clips

Drive the packaged plugin in distro OBS, not just the upload probe. Drive both web apps: the hosted Worker uses D1 for accounts and YouTube; the self-hosted Worker uses a local R2 binding for playable files. Moto stands in for an S3 service and `youtube_local.py` stands in for Google's OAuth/upload API. Neither proves production cloud access.

## Launch in a fresh x86_64 Amp orb

Use a disposable checkout with no OBS process, existing `web/.dev.vars` or `web/.wrangler/state`. Don't move someone else's state to make room: the fixture hardcodes D1 and port 9393. The lab refuses occupied ports, uses a private Xvfb display `:97`, and scopes every service and browser session to the run ID. Run from the repository root in Bash. Read the `using-agent-browser` skill before driving Chromium.

```bash
.agents/setup
sudo -n apt-get update -qq
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  obs-studio xvfb xdotool openbox xclip x11-utils libgl1-mesa-dri sqlite3 \
  python3-pyatspi at-spi2-core dbus-x11 ffmpeg imagemagick iptables jq
uv tool install 'moto[server]'
agent-browser skills get core --full >/dev/null
S=$PWD/.agents/skills/verify-better-clips/scripts
id=$(date +%s | tail -c 9)  # eight digits; keep the same id through cleanup
E=$PWD/.amp/in/artifacts/bc-$id
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NO_PROXY=localhost,127.0.0.1,::1
"$S/lab" start "$id"
```

`lab start` builds the web assets, creates a mode-0700 credential directory in tmpfs, and links its ephemeral variables file as `web/.dev.vars`. It sets `CREDS_KEY` to 32 random bytes in base64, both Google credentials to the fake's exact `test-client`/`test-secret`, `GOOGLE_OAUTH` and `YOUTUBE_API` to `http://127.0.0.1:9393`, and a separate disposable app password. It applies `pnpm exec wrangler d1 migrations apply clips-app --local -c wrangler.app.jsonc` **from `web/`**, then starts `wrangler dev --local -c wrangler.app.jsonc` on 8787 and `wrangler dev --local -c wrangler.jsonc --assets dist/client` on 8788. The second Worker matters: a Google login doesn't give the hosted account an R2 bucket. Nothing deploys or migrates remotely.

## Doctor

`"$S/lab" doctor "$id"` must identify both real sign-in challenges, the actual list of applied migrations, the S3 bucket, Xvfb, and the loaded plugin version when OBS is running. It rejects a response on a non-loopback interface. An orb can forward `127.0.0.1` listeners to its virtual network interface; the lab installs a temporary, run-labelled firewall rule for its ports. Do not publish these fakes or their inspector ports through a portal.

## Drive one full run

```bash
set -e
"$S/lab" doctor "$id"
"$S/lab" protocol "$id"
for chapter in upgrade stores library channel edit direct; do
  "$S/drive" "$chapter" "$id"
done
"$S/lab" gates "$id"
```

Run chapters in order against the same instance. [Feature map](features/README.md) lists each chapter's preconditions, controls and proof. A failure leaves the instance and screenshots in place: use doctor, the named service logs (`amp orb service logs bc-$id-host`) and a fresh UI snapshot. Record the failure; do not seed the expected result to get past it. Use a new ID for a clean rerun. `gates` runs all checks even when one fails; it deliberately returns nonzero if any failed.

- `protocol` runs the repo's full `python3 web/worker/tests/youtube_local.py` exercise, then `scripts/no-qt-tls.sh` (also runnable alone with `R=/dev/shm/better-clips-$UID-$id`), then starts the interactive `--serve` fake. Both fake modes own 9393: never run them simultaneously. The probe tests partial receipts, retries, byte identity, scope handling, failed processing, sync and revocation independently of the UI run. It seeds a disposable session; it is **not** proof a user signed in.
- `upgrade` downloads the published 0.2.0 Linux .deb. It builds the candidate with `cmake --preset ubuntu-x86_64 -DCMAKE_COMPILE_WARNING_AS_ERROR=ON -DYOUTUBE_CLIENT_ID=test-client -DYOUTUBE_CLIENT_SECRET=test-secret` and `cmake --build build_x86_64 --parallel 2`. Without the two definitions, **Directly to YouTube** is unavailable. It packages with CPack and runs the real `install.sh` with `OBS_R2_PACKAGE` and the display unset, so only the harness opens OBS. Distro OBS and `libobs-dev` must match; don't use Flatpak. The installer can remove a system-wide old plugin; the harness refuses to run over one.
- `gates` checks clang-format **19** via `build-aux/run-clang-format --fail-error --check`, the full-tree `build-aux/run-gersemi --fail-error --check`, and `pnpm check` and `pnpm build` in `web/`. Keep them separate from the flow verdicts. The stock OBS frontend may warn about missing capture hardware in Xvfb; check for a loaded plugin and a working software encoder instead.

### Drive by hand at a failure

```bash
export DISPLAY=:97 R=/dev/shm/better-clips-$UID-$id
"$S/obs-ui"                       # visible roles, names and positions on the lab display
"$S/obs-ui" Settings --role button --last   # Better Clips dock, not OBS Settings
xdotool getactivewindow getwindowname
agent-browser --session "yt-$id" snapshot -i
import -window root -resize 1100 "$E/obs-at-failure.jpg"
```

`obs-ui` locates controls through Qt accessibility, then uses **xdotool** to move the pointer and click. Roles and names distinguish the combo box from its hidden list items. If a window manager hides a modal, `xdotool windowactivate --sync "$(xdotool search --name '^Upload this clip to YouTube\?' | tail -1)"`. Use fresh a11y refs after web mutations. Wait for a signed-in or signed-out control: the React shell briefly renders an empty library before `/api/me` resolves. Do not take that shell as proof of sign-in.

### Real Google and native macOS require the owner

Use a dedicated owner-approved test channel and the owner's normal browser on the **same machine as OBS** (the pairing callback goes to loopback). For hosted mode register the exact `http://localhost:8787/api/youtube/callback` on a Google **Web** OAuth client, set its ID/secret and a persistent `CREDS_KEY` privately in the local Worker, remove `GOOGLE_OAUTH` and `YOUTUBE_API`, and start the migrated Worker as above. For direct mode rebuild with a **Desktop** OAuth client; unset all three `YOUTUBE_*` endpoint overrides (and the lab's browser opener). Don't use `lab start` or `protocol` with live credentials. Have the owner sign in, complete the phone prompt and explicitly grant the requested scopes. Don't capture the consent URL, phone, codes or tokens.

Choose Private, save a short identifiable clip, wait for both notifications, and have the owner open the copied link and play past the first frame. Check Studio title, privacy, duration/audio, through-app edits and disconnect. Direct uploads should not appear in the app library. Confirm before deleting a real video. On macOS repeat with the actual shipped OBS/Qt and `.pkg`; the Linux no-TLS probe proves the transport, not a Mac package, system keychain or device. Cloudflare OAuth, provisioning a real BYOB bucket and AWS signature acceptance also need owner-approved accounts and resources; local R2 and Moto aren't substitutes for those claims.

## Evidence and cleanup

Keep screenshots, the OBS and browser recordings, safe logs, clipboard **result links from the fake**, and the redacted state observations in `$E` (`.amp/in/artifacts/bc-$id/`). Inspect the images and the recording frames. Match a visible user action to its independent result: new object/bytes, advancing video time, D1 metadata, or a revoked credential. A green toast alone isn't proof. Do not share full plugin config, `.dev.vars`, D1 databases, setup codes or OAuth URLs. The fake does not host YouTube embeds or thumbnails: record **unavailable**, not a playback pass, on that surface.

```bash
"$S/lab" stop "$id"              # also after a failed run; requires this checkout's run marker
test -d "$E" && ls -lh "$E"      # earlier runs and evidence survive teardown
```

`stop` removes only this run's browser sessions, services, variable/state links, firewall rule and tmpfs directory. Build outputs and dependencies remain cached. Use `maintain-verification-skill` to recheck the feature map when a user path changes.
