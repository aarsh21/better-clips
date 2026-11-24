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

1. In Cloudflare, create an R2 bucket.
2. Go to **R2 > Manage API tokens** and create a token with
   **Object Read & Write** for that bucket. Copy the Access Key ID and
   Secret Access Key.
3. In the bucket's **Settings**, copy the **S3 API** URL. It looks like
   `https://<account-id>.r2.cloudflarestorage.com/<bucket>`.
4. Optional: to get share links, turn on **Public Development URL**
   (`https://pub-xxxx.r2.dev`) or connect a custom domain.
5. In OBS, open **Tools > Replay to R2 Settings**, fill in the fields, and
   click **Test Upload**.
6. In **Settings > Output**, enable the Replay Buffer. In **Settings > Hotkeys**,
   bind **Save Replay to Cloudflare R2**.
7. Start the Replay Buffer and press your hotkey.

To stay within R2's free 10 GB, add a lifecycle rule to the bucket, such as
deleting objects in `replays/` after 30 days.

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
