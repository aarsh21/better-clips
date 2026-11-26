# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome. For
anything bigger than a small fix, open an issue first so we can agree on the
approach before you spend time on it.

## Project layout

```
src/                  the OBS plugin (C++17, libobs, Qt 6, libcurl)
  replay-output.cpp     the in-memory replay buffer, attached to OBS's encoders
  memory-mux.cpp        writes the MP4 in memory (H.264/HEVC/AV1, AAC/Opus)
  uploader.cpp          upload queue and retries
  youtube-upload.cpp    resumable uploads to YouTube, through the app or directly
  save-dock.cpp         the Better Clips dock
  settings-dialog.cpp   Tools → Better Clips Settings
web/                  the clips app (Cloudflare Worker + React), see web/README.md
  worker/               API routes, account sessions and YouTube OAuth/uploads
  src/                  the React app
  migrations/           D1 schema for hosted mode
install.sh, install.ps1 one-line installers
.github/              CI: plugin builds for Windows, macOS and Linux; web checks
```

## The plugin

Build it on Linux with:

```sh
sudo apt install obs-studio libobs-dev qt6-base-dev libcurl4-openssl-dev libsecret-1-dev cmake ninja-build pkg-config
cmake --preset ubuntu-x86_64
cmake --build build_x86_64
```

Then copy `build_x86_64/better-clips.so` into
`~/.config/obs-studio/plugins/better-clips/bin/64bit/` and the `data/` folder
into `~/.config/obs-studio/plugins/better-clips/data/`, and start OBS. On
Windows and macOS use the `windows-x64` and `macos` presets, or push to your
fork and download the builds from GitHub Actions.

Before you push:

- Format C++ with `clang-format` 19 and CMake with `gersemi`
  (`build-aux/run-clang-format` and `build-aux/run-gersemi`). CI rejects
  unformatted code.
- If you touch `memory-mux.cpp`, check the output with real encoder output:
  `ffprobe` should report the right duration, and
  `ffmpeg -v error -i clip.mp4 -f null -` should print nothing. Test every codec
  you changed.
- Keep the plugin free of FFmpeg and other libraries that change their binary
  interface between OBS versions. One build has to load on OBS 31 to 33.

## The web app

```sh
cd web
pnpm install
cp .dev.vars.example .dev.vars   # see web/README.md for OAuth configuration
pnpm exec wrangler d1 migrations apply clips-app --local
pnpm dev
pnpm check                       # must pass before you open a pull request
```

`pnpm check` runs TypeScript, ESLint, Oxlint with the anti-slop rules and
React Doctor, which has to stay at 100. Format with `pnpm format`.

Changes to the database go in a
new numbered file in `web/migrations/`; never edit one that has shipped.

## Pull requests

- Keep each pull request to one change, and explain what it fixes and how you
  checked it. Screenshots help for anything visible.
- Write commit messages in plain sentences that say what changed and why.
- Don't bump versions or edit `buildspec.json`'s version; releases do that.

## Releases

Maintainers release by bumping `version` in `buildspec.json`, committing
"Release x.y.z" and pushing a tag `x.y.z`. GitHub Actions builds the packages
and drafts the release.

## Code of conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
