# Replay to R2 for OBS

Press a hotkey and the last N seconds of gameplay upload straight to your
Cloudflare R2 bucket. The clip goes from memory to the upload and is never
written to disk.

## How it works

- When you start OBS's Replay Buffer, the plugin starts its own in-memory
  replay buffer on the same encoders, so it adds no encoding work. It uses the
  same length and size limits as OBS's replay buffer (Settings > Output).
- When you press **Save Replay to Cloudflare R2**, the plugin packages the
  buffered video and audio into an MP4 in memory and uploads it in the
  background.
- When the upload finishes, the OBS status bar shows the result. If you set a
  public URL, the plugin also copies the clip's link to your clipboard.
- Clips are named so you can browse them: a folder per day, then the time and
  the scene, e.g. `replays/2026-11-24/14-35-07_Valorant.mp4`. With a public URL,
  a 6-letter code is added (`..._Valorant_k3f9x2.mp4`) so nobody can guess
  a clip's link from the time.
- If an upload fails, it retries for about 2 minutes. After that, the clip is
  lost, because it was never saved to disk.

OBS's own **Save Replay** button and hotkey still save a file as usual. Use the
plugin's hotkey instead.

## Setup

It takes about two minutes, and you need no R2 API keys.

1. Deploy your own clips app to Cloudflare, which is free:

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aarsh21/obs-replay-r2/tree/main/web)

   Cloudflare creates the R2 bucket for you. Pick a password when it asks
   for `APP_PASSWORD`.
2. Open your app (`https://clips.<you>.workers.dev`), sign in and click
   **Connect OBS** (later: the gear icon). Copy the install command for your
   system and paste it into a terminal:

   ```sh
   # macOS / Linux
   curl -fsSL https://raw.githubusercontent.com/aarsh21/obs-replay-r2/main/install.sh | sh -s -- '<setup code>'
   ```

   ```powershell
   # Windows (PowerShell)
   $env:CLIPS_SETUP_CODE='<setup code>'; irm https://raw.githubusercontent.com/aarsh21/obs-replay-r2/main/install.ps1 | iex
   ```

   It waits for OBS to close, installs the plugin, connects it to your app,
   turns on the Replay Buffer, binds **Ctrl+Alt+R** and opens OBS. Nothing
   needs sudo; Windows asks once for permission. The command holds your setup
   code, so keep it private.
3. Press **Ctrl+Alt+R** in a game. The clip shows up in your app.

To set it up by hand instead: install the plugin from the
[latest release](https://github.com/aarsh21/obs-replay-r2/releases/latest)
(0.1.1 or newer), then in OBS open **Tools > Replay to R2 Settings**, click
**Paste setup code**, then **Test Upload** and **Save**. Enable the Replay
Buffer in **Settings > Output** and bind **Save Replay to Cloudflare R2** in
**Settings > Hotkeys**.

The Linux script installs into your OBS config folder and supports OBS from
your distro's packages or PPA on x86_64. It doesn't support Flatpak OBS.

Clips upload through your app, which deletes new clips after 30 days and the
trash after 7; change both in **Settings → Storage**. Clips you keep stay. R2's first 10 GB a month are free; past
that, storage costs about $0.015 per GB a month.

### Without the app

The plugin can also upload straight to any S3-compatible bucket. Create an R2
API token with **Object Read & Write** for your bucket, then fill in **S3 API
URL** (`https://<account-id>.r2.cloudflarestorage.com/<bucket>`), **Access Key
ID** and **Secret Access Key** in the settings, and leave **Clips app** empty.

## Building

This project is based on
[obs-plugintemplate](https://github.com/obsproject/obs-plugintemplate). It
needs libobs, obs-frontend-api, Qt 6, FFmpeg (libavformat, libavcodec,
libavutil), and libcurl.

Linux (Debian/Ubuntu):

```sh
sudo apt install obs-studio libobs-dev qt6-base-dev libavformat-dev libavcodec-dev libavutil-dev libcurl4-openssl-dev cmake ninja-build pkg-config
cmake --preset ubuntu-x86_64
cmake --build build_x86_64
```

On Windows and macOS, push to GitHub and use the template's GitHub Actions
workflow. You can also follow the template's build instructions for those
platforms.
