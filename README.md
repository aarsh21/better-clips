<div align="center">

# Better Clips

**Press a hotkey in a game. The last 30 seconds are in your browser a moment later.**

An OBS plugin that saves a local MP4 and uploads your replay to your YouTube channel. Use the dashboard to watch, rename, share or delete your uploads.

[![Latest release](https://img.shields.io/github/v/release/aarsh21/better-clips?label=release&color=f0a640)](https://github.com/aarsh21/better-clips/releases/latest)
[![Build](https://img.shields.io/github/actions/workflow/status/aarsh21/better-clips/push.yaml?branch=main&label=plugin%20build)](https://github.com/aarsh21/better-clips/actions/workflows/push.yaml)
[![Web app](https://img.shields.io/github/actions/workflow/status/aarsh21/better-clips/web.yaml?branch=main&label=web%20app)](https://github.com/aarsh21/better-clips/actions/workflows/web.yaml)
[![OBS 31–33](https://img.shields.io/badge/OBS-31%20%E2%80%93%2033-302e31?logo=obsstudio)](https://obsproject.com)
[![License: GPL-2.0](https://img.shields.io/github/license/aarsh21/better-clips?color=blue)](LICENSE)

[Install](#install) · [How it works](#how-it-works) · [The web app](web/README.md) · [FAQ](#faq) · [Contributing](CONTRIBUTING.md)


</div>

## Features

- Capture a replay without encoding it a second time. Keep the MP4 in your OBS recording folder, even after YouTube finishes processing.
- Upload through the Better Clips app to manage clips in the dashboard, or connect directly to YouTube from OBS.
- Choose the audio track, title, privacy and audience before uploading. Enable review to check each clip first.
- Copy a YouTube link or open your own upload in YouTube Studio to download it. Clip editing is coming soon.

## Install

**1. Install the plugin.** Run this in a terminal:

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/aarsh21/better-clips/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/aarsh21/better-clips/main/install.ps1 | iex
```

The script waits for OBS to close and checks the new plugin before replacing
the installed copy. On upgrade it keeps the previous Better Clips version in
`plugin-backups`, beside OBS’s `plugins` directory. You can also install a package from the [latest release](https://github.com/aarsh21/better-clips/releases/latest).

**2. Connect YouTube.** Click **Connect YouTube** in the Better Clips dock, or open **Tools → Better Clips Settings**. Leave **Through the Better Clips app** selected to use the [dashboard](https://clips.zabimaru.me/apps/). Sign in with YouTube and click **Save**.

**3. Save a replay.** Start the Replay Buffer and press **Ctrl+Alt+R**, or use the dock button. Change the shortcut in **Settings → Hotkeys**.

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

OBS buffers encoded packets in memory, writes a local MP4 when you save, and uploads straight to YouTube. The hosted Worker starts a resumable upload and tracks its library entry; video bytes do not pass through it. Direct uploads bypass the Worker and do not appear in the dashboard.

## FAQ

<details>
<summary><b>What happens if my internet drops while saving?</b></summary>

The plugin retries transient failures for about two minutes. The MP4 stays in your OBS recording folder whether the upload succeeds or fails.


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
<summary><b>The hotkey only works while OBS is focused (Hyprland and other Wayland desktops)</b></summary>

Wayland only sends key presses to the focused window, and OBS has no global
hotkey support there yet
([obs-studio#10538](https://github.com/obsproject/obs-studio/issues/10538)).
On Hyprland, keep your key bound to **Save Replay and Upload** in OBS
(Ctrl + Alt + R below) and let Hyprland pass it to OBS:

```lua
-- Hyprland 0.55 or newer (Lua config)
hl.bind("CTRL + ALT + R", hl.dsp.pass({ window = [[class:com\.obsproject\.Studio]] }))
```

```ini
# Older Hyprland (hyprland.conf)
bind = CTRL ALT, R, pass, class:^(com\.obsproject\.Studio)$
```

If nothing happens, check OBS's window class with `hyprctl clients`.

Alternatively, install
[obs-wayland-hotkeys](https://github.com/leia-uwu/obs-wayland-hotkeys) (AUR:
`obs-wayland-hotkeys-git`), which registers OBS's hotkeys with the
GlobalShortcuts portal. It needs `xdg-desktop-portal-hyprland`. Assign a key in
the dialog it shows when OBS starts, find the shortcut's name with
`hyprctl globalshortcuts`, and bind it with Hyprland's `global` dispatcher. See
the [Hyprland wiki](https://wiki.hypr.land/configuring/core/binds/globals/).

</details>

<details>
<summary><b>Which format makes the smallest clips?</b></summary>

The plugin doesn't re-encode, so size depends only on your OBS encoder
settings; the MP4 container adds about 0.03%. AV1 gives the smallest files for
the same quality, and a quality-based rate control (CQP or QVBR) saves more than
CBR on quiet scenes. Note that older iPhones and Macs can't play AV1.

</details>

## Building

The plugin is based on
[obs-plugintemplate](https://github.com/obsproject/obs-plugintemplate) and needs
libobs, obs-frontend-api, Qt 6 and libcurl.

```sh
# Debian / Ubuntu
sudo apt install obs-studio libobs-dev qt6-base-dev libcurl4-openssl-dev libsecret-1-dev cmake ninja-build pkg-config
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
