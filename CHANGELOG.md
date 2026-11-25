# Changelog

All notable changes. The plugin follows [semantic versioning](https://semver.org);
the web app ships from `main`.

## Unreleased

### Web app

- A **12-hour / 24-hour** time setting in Settings → Appearance.
- Clips have a **category**, the window or scene OBS saved from, and a title:
  the name you give it, or "Clip 1", "Clip 2" and so on. Renaming keeps the
  category.
- **Sort** clips by newest, oldest, length, size or name, and **filter** by
  category.
- A **Share** button on each clip card.
- In the player, ↑ ↓ or H L change clips, and ← → seek.
- Automatic setup reuses your account's `clips` bucket instead of making a
  new one, so signing in again shows your existing clips.
- Fixed the page going blank when opening the **Share** menu.
- An **Empty trash** button on the Trash tab.
- The storage screen now says which option is for a bucket that already holds
  your clips.
- **Hosted mode.** One deployment can serve many people: sign in with
  Cloudflare and bring your own R2 bucket, either one the app creates or one
  you connect with a bucket-only key. Videos load straight from each bucket
  through short-lived signed links. OBS 0.1.3 and later upload unchanged.
- Share links are pinned to the recording and thumbnail they were made from.
- Cleanup in a connected bucket waits until you confirm the lengths, and only
  deletes `.mp4` clips.
- **YouTube.** Sign in with Google and your YouTube clips show up next to your
  bucket clips: play, rename, change visibility, cut and delete them. Google
  asks once for every permission. New **FAQ** and **Privacy** pages.

## [0.3.1]

- Fixed YouTube sign-in and uploads on OBS builds that ship without a Qt TLS backend, including macOS. Failed requests now report the HTTP status or curl error in the OBS log.

## [0.3.0] - 2026-11-25

- Replay to R2 is now **Better Clips**. The installer removes the old plugin,
  but leaves its settings intact. Better Clips copies them on first launch,
  including your destination and sign-ins. Your hotkey, dock layout and
  existing setup codes still work.

## [0.2.0] - 2026-11-25

### Plugin

- **YouTube** is a new destination. Choose it in **Tools → Replay to R2
  Settings**, sign in with Google, and saved replays upload to your channel as
  unlisted, private or public videos. The video link is copied when the upload
  finishes, and OBS tells you when YouTube has processed it.
- Upload **through the Clips app**, so clips show up in its library, or
  **directly to YouTube**, with no Clips app at all.
- Pick the audio track that goes to YouTube, set a title template and
  description, and optionally review each clip before it uploads.
- Uploads resume after a dropped connection. Clips that can't be uploaded are
  saved to disk instead, including when you quit OBS mid-upload.

## [0.1.7] - 2026-11-25

### Plugin

- A clip's category is the app you're using, such as "Google Chrome", not its
  window title, so every tab or document of one app lands in one category.
  On Hyprland, the app's installed name is used.

## [0.1.6] - 2026-11-25

### Plugin

- Clips are named after the window you're using when you save, usually the
  game, instead of the OBS scene: on Windows, macOS and Hyprland. Elsewhere,
  or when OBS is focused, the scene name is still used.

## [0.1.5] - 2026-11-25

### Plugin

- A clip that can't be uploaded is saved to OBS's recording folder instead of
  being lost: after every retry fails, when OBS closes mid-upload, or when 3
  clips are already waiting to upload.

## [0.1.4] - 2026-11-24

### Plugin

- Write MP4s without FFmpeg, so one build loads on OBS 31, 32 and 33. OBS 33
  ships FFmpeg 8, and plugins linked to FFmpeg 7 failed to load on Windows.
- Supports H.264, HEVC and AV1 video and AAC and Opus audio, with the index at
  the start for instant browser playback.

## [0.1.3] - 2026-11-24

### Plugin

- A **Replay to R2** dock next to Controls with a Save button, the replay
  length and the last result.
- A new replay length applies to the running buffer right away, and clips
  always cover at least that length.

### Web app

- Trims are numbered after their source (Trim 1, Trim 2).
- Keep and Delete buttons on clip cards.

## [0.1.2] - 2026-11-24

- One-line install scripts for Windows, macOS and Linux. On its next start the
  plugin applies the setup code, turns on the Replay Buffer, binds
  **Ctrl+Alt+R** and checks the connection.
- Web app: search (`/` or `⌘K`), a light theme, retention settings and OBS
  connection status.
- Fixed `Content-Range` on clip video responses, which broke seeking.

## [0.1.1] - 2026-11-24

- One-click **Deploy to Cloudflare** for the clips app, with password sign-in.
- OBS uploads through the app with a setup code, so no R2 API keys are needed.
- Multipart uploads in 50 MB parts, past the Worker's 100 MB request limit.
- Daily cleanup of old replays and the trash.

## [0.1.0] - 2026-11-24

- First release: an in-memory replay buffer on OBS's encoders that uploads
  clips to Cloudflare R2 without writing them to disk.
- The clips web app to browse, preview, trim, keep, delete and share clips.

[0.3.1]: https://github.com/aarsh21/better-clips/releases/tag/0.3.1
[0.3.0]: https://github.com/aarsh21/better-clips/releases/tag/0.3.0
[0.1.7]: https://github.com/aarsh21/better-clips/releases/tag/0.1.7
[0.1.6]: https://github.com/aarsh21/better-clips/releases/tag/0.1.6
[0.1.5]: https://github.com/aarsh21/better-clips/releases/tag/0.1.5
[0.1.4]: https://github.com/aarsh21/better-clips/releases/tag/0.1.4
[0.1.3]: https://github.com/aarsh21/better-clips/releases/tag/0.1.3
[0.1.2]: https://github.com/aarsh21/better-clips/releases/tag/0.1.2
[0.1.1]: https://github.com/aarsh21/better-clips/releases/tag/0.1.1
[0.1.0]: https://github.com/aarsh21/better-clips/releases/tag/0.1.0
