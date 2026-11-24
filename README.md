<div align="center">

# Replay to R2

**Press a hotkey in a game. The last 30 seconds are in your browser a moment later.**

An OBS plugin that sends your replay buffer straight to Cloudflare R2, without
ever writing the clip to disk, and a fast web app to watch, trim, keep and share
what it uploads.

[![Latest release](https://img.shields.io/github/v/release/aarsh21/obs-replay-r2?label=release&color=f0a640)](https://github.com/aarsh21/obs-replay-r2/releases/latest)
[![Build](https://img.shields.io/github/actions/workflow/status/aarsh21/obs-replay-r2/push.yaml?branch=main&label=plugin%20build)](https://github.com/aarsh21/obs-replay-r2/actions/workflows/push.yaml)
[![Web app](https://img.shields.io/github/actions/workflow/status/aarsh21/obs-replay-r2/web.yaml?branch=main&label=web%20app)](https://github.com/aarsh21/obs-replay-r2/actions/workflows/web.yaml)
[![OBS 31–33](https://img.shields.io/badge/OBS-31%20%E2%80%93%2033-302e31?logo=obsstudio)](https://obsproject.com)
[![License: GPL-2.0](https://img.shields.io/github/license/aarsh21/obs-replay-r2?color=blue)](LICENSE)

[Install](#install) · [How it works](#how-it-works) · [The web app](web/README.md) · [FAQ](#faq) · [Contributing](CONTRIBUTING.md)

![The clips web app](docs/images/app-dark.webp)

</div>

## Why

OBS's Replay Buffer writes every clip to disk, and then you still have to find
the file, upload it somewhere and copy a link. Replay to R2 skips all of that:

- **Never touches disk.** The plugin keeps its own replay buffer in memory,
  packages the clip as an MP4 in memory and uploads it in the background.
- **No extra encoding.** It reuses the frames OBS already encoded for its
  Replay Buffer, so it costs no GPU or CPU while you play.
- **Your storage, your clips.** Clips go to your own R2 bucket. R2 has no
  egress fees and the first 10 GB a month are free.
- **Ready to share.** The MP4 has its index up front, so clips start playing
  instantly in the browser, and share links embed as video in Discord.

## Features

<table>
<tr>
<td width="50%" valign="top">

**In OBS**

- **Save Replay to R2** hotkey and a dock next to Controls
- Change the replay length live, without restarting the buffer
- Retries failed uploads for about 2 minutes
- H.264, HEVC and AV1 video, AAC and Opus audio, every audio track
- One build works on OBS 31, 32 and 33
- One-line installer for Windows, macOS and Linux

</td>
<td width="50%" valign="top">

**In the web app**

- Clips grouped by day, with hover previews and search (`/` or `⌘K`)
- Lossless trimming in the browser, with no re-encoding
- Keep forever, trash, restore, rename, download
- Share links that expire after 1, 7 or 30 days, or never
- Automatic cleanup of old clips and the trash
- Light and dark themes, full keyboard control

</td>
</tr>
</table>

<table>
<tr>
<td width="50%"><img src="docs/images/obs-dock.webp" alt="The Replay to R2 dock in OBS, after an upload"></td>
<td width="50%"><img src="docs/images/trim.webp" alt="Trimming a clip in the browser"></td>
</tr>
<tr>
<td align="center"><sub>The dock in OBS, right after an upload</sub></td>
<td align="center"><sub>Lossless trimming on a filmstrip</sub></td>
</tr>
</table>

## Install

Setup takes about two minutes and needs no R2 API keys.

**1. Deploy your clips app.** It runs free on Cloudflare Workers, and Cloudflare
creates the R2 bucket for you. Pick a password when it asks for `APP_PASSWORD`.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aarsh21/obs-replay-r2/tree/main/web)

**2. Connect OBS.** Open your app, sign in and click **Connect OBS**. Copy the
command for your system into a terminal:

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/aarsh21/obs-replay-r2/main/install.sh | sh -s -- '<setup code>'
```

```powershell
# Windows (PowerShell)
$env:CLIPS_SETUP_CODE='<setup code>'; irm https://raw.githubusercontent.com/aarsh21/obs-replay-r2/main/install.ps1 | iex
```

The script waits for OBS to close, installs the latest release, connects it to
your app, turns on the Replay Buffer, binds **Ctrl+Alt+R** and reopens OBS.
Nothing needs sudo. The command contains your setup code, so keep it private.

**3. Play.** Press **Ctrl+Alt+R** and the clip shows up in your app.

<details>
<summary><b>Install by hand</b></summary>

1. Download the package for your system from the
   [latest release](https://github.com/aarsh21/obs-replay-r2/releases/latest):
   the `.zip` for Windows, the `.pkg` for macOS, or the `.deb` for Ubuntu and
   Debian.
2. In OBS, open **Tools → Replay to R2 Settings**, click **Paste setup code**,
   then **Test Upload** and **Save**.
3. Enable the Replay Buffer in **Settings → Output**, and bind **Save Replay to
   Cloudflare R2** in **Settings → Hotkeys**.

</details>

<details>
<summary><b>Upload straight to a bucket, without the app</b></summary>

The plugin can upload to any S3-compatible bucket. Create an R2 API token with
**Object Read & Write** for one bucket, then fill in **S3 API URL**
(`https://<account-id>.r2.cloudflarestorage.com/<bucket>`), **Access Key ID**
and **Secret Access Key** in the plugin settings and leave **Clips app** empty.

</details>

### Requirements

| | Supported |
|---|---|
| OBS | 31, 32 and 33 |
| Windows | 10 and 11, x64 |
| macOS | 12 or newer, Apple Silicon and Intel |
| Linux | x86_64, OBS from your distro or the OBS PPA (Flatpak OBS isn't supported yet) |
| Video encoders | Anything that outputs H.264, HEVC or AV1: x264, NVENC, AMF, Quick Sync, Apple VT, SVT-AV1 |
| Audio encoders | AAC or Opus |

## How it works

```mermaid
flowchart LR
  subgraph OBS
    E[Encoders] --> RB[OBS Replay Buffer]
    E --> MB[Plugin's in-memory buffer]
  end
  MB -- hotkey --> MUX[MP4 in memory] -- multipart upload --> W[Clips app<br/>Cloudflare Worker]
  W --> R2[(Your R2 bucket)]
  B[Browser] -- signed links --> R2
  B --> W
```

1. When OBS's Replay Buffer starts, the plugin attaches a second output to the
   same encoders. It keeps the same length and size limits as OBS's buffer
   (**Settings → Output**) and keeps whole groups of pictures, so a clip always
   covers at least the length you set.
2. On the hotkey, it copies the buffered packets and writes an MP4 itself.
   There's no FFmpeg involved, which is why one build loads on every supported
   OBS version. On a 4-core machine, a 60-second 1080p60 clip at 40 Mbps
   packages in about 0.2 s, roughly 3× faster than FFmpeg's MP4 muxer.
3. It uploads the MP4 in 50 MB parts through your clips app, which checks the
   upload token and writes to R2. The upload runs on its own thread and never
   blocks OBS.
4. Clips are named by day, time and scene, such as
   `replays/2026-11-24/14-35-07_Valorant.mp4`.

The app is a single Cloudflare Worker next to your bucket, so bucket keys never
reach the browser. See [web/README.md](web/README.md) for its design, bucket
layout and deployment options.

## FAQ

<details>
<summary><b>What happens if my internet drops while saving?</b></summary>

The plugin retries for about 2 minutes. Because the clip only exists in memory,
it's lost if every retry fails, and OBS's status bar tells you. Up to 3 clips
can wait in the queue at once.

</details>

<details>
<summary><b>Does it slow down my game or stream?</b></summary>

No extra encoding happens: the plugin reuses OBS's encoded frames. Packaging
and uploading run on a background thread. The clip is briefly held twice in
memory while it's packaged (about 90 MB for a minute at 12 Mbps), then the
buffered frames are freed.

</details>

<details>
<summary><b>Does OBS's own Save Replay still work?</b></summary>

Yes. OBS's **Save Replay** button and hotkey still save a file as usual. The
plugin adds its own button and hotkey next to them.

</details>

<details>
<summary><b>Which format makes the smallest clips?</b></summary>

The plugin doesn't re-encode, so size depends only on your OBS encoder
settings; the MP4 container adds about 0.03%. AV1 gives the smallest files for
the same quality, and a quality-based rate control (CQP or QVBR) saves more than
CBR on quiet scenes. Note that older iPhones and Macs can't play AV1.

</details>

<details>
<summary><b>How much does it cost?</b></summary>

The Worker fits in Cloudflare's free plan. R2 includes 10 GB of storage a month
for free, then about $0.015 per GB a month, and downloads are always free. The
app deletes new clips after 30 days and the trash after 7 by default; change
that in **Settings → Storage**. Clips you keep stay.

</details>

<details>
<summary><b>Can I hide something by trimming before I share?</b></summary>

Not reliably. Trims aren't re-encoded, so the file starts at the keyframe before
your in point, and up to a couple of seconds before it are still in the file.

</details>

## Building

The plugin is based on
[obs-plugintemplate](https://github.com/obsproject/obs-plugintemplate) and needs
libobs, obs-frontend-api, Qt 6 and libcurl.

```sh
# Debian / Ubuntu
sudo apt install obs-studio libobs-dev qt6-base-dev libcurl4-openssl-dev cmake ninja-build pkg-config
cmake --preset ubuntu-x86_64
cmake --build build_x86_64
```

For Windows and macOS, use the `windows-x64` and `macos` presets, or push to a
fork and let GitHub Actions build all three. The web app lives in [`web/`](web)
and builds with `pnpm install && pnpm build`.

## Contributing

Bug reports, ideas and pull requests are welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) for how the project is laid out and what the
checks expect, and [SECURITY.md](SECURITY.md) to report a vulnerability
privately.

## License

[GPL-2.0](LICENSE), like OBS itself. Not affiliated with OBS Project or
Cloudflare.
