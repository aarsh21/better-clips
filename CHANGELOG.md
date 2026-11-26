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
- Each OBS install is paired on its own. Remove one in Settings without
  signing out of Google; disconnecting the whole channel asks first, counts
  what it removes and says your videos stay on YouTube.
- A failed or interrupted disconnect keeps your Google connection so you can
  retry, and a newer sign-in made meanwhile is never removed.
- Cancelling Google sign-in or leaving out a permission shows OBS the real
  reason. Signing in again doesn't ask for consent twice.
- The storage check writes a real test file, and OBS readiness only turns
  green after a recent successful upload.
- A retried upload whose reply was lost returns the same clip instead of
  failing or making a second copy.
- If your bucket or YouTube is unavailable, the other source and cached clips
  still show. A video missing from YouTube keeps its cuts for a week of
  rechecks before it's removed.
- Interrupted moves to and from Trash are finished later without duplicates.
- Titles hide the unique ID in new clip names. Setup explains the Cloudflare
  permissions it needs, and an empty library no longer looks like first-run
  setup.
- A new homepage at `/`. The dashboard moved to `/apps/`; old links and
  sign-in redirects forward there. Self-hosted installs open the app directly.
- A new, quieter look across the whole app, in light and dark, on desktop and
  phone. New **Terms** page.
- Before connecting YouTube, the app lists what it will do on your channel and
  asks you to agree to the Terms, Privacy policy and YouTube Terms.
- Google sign-in asks for fewer permissions: your account ID, email, and
  YouTube management.
- Set **Made for kids?** once in Settings → YouTube. Uploads from older OBS
  versions use it.
- Videos that are made for kids, or whose audience isn't confirmed yet, open on
  YouTube instead of playing in the app.

## [0.5.0] - 2026-11-26

### Plugin

- **Direct YouTube sign-in is kept in your system's secure storage**: Keychain
  on macOS, Credential Manager on Windows, and the keyring on Linux. Upgrading
  moves an existing sign-in there and removes it from the settings file. With
  no keyring, OBS keeps it for the current session only and tells you once.
- Direct YouTube sign-in asks only to upload videos and view your channel.
- Choose **Made for kids?** in the YouTube settings. Until you do, clips are
  saved to disk instead of uploaded.
- YouTube's upload terms are shown in the settings and next to **Upload**.

## [0.4.0] - 2026-11-26

### Plugin

- **Clips are never shorter than your setting** once the buffer has recorded
  that long. A clip starts at the last keyframe before the moment you asked
  for and ends when you press Save. If
  your encoder's keyframes are more than 2 s apart, Better Clips tells you once
  and suggests a 1–2 s keyframe interval.
- YouTube clips keep a local copy until YouTube has processed them, so a
  rejected upload is never lost, even across an OBS restart.
- Every save gets a unique name, and uploads never overwrite an existing clip.
- Two quick presses give two clips, each with the settings it was pressed
  with. A busy queue saves to disk, and a full one declines the press clearly.
- The YouTube review dialog no longer blocks other uploads.
- FLAC and PCM audio, which can't go into an MP4, are refused when you start
  the buffer, with a hint to use AAC or Opus. A clip that can't be written to
  your recording folder is saved to a recovery folder instead.
- S3 uploads sign for the right region: AWS, virtual-host buckets, dualstack,
  Wasabi and Backblaze. A region correction from the server is followed.
- Errors that won't fix themselves save the clip to disk immediately. Quitting
  OBS mid-upload no longer stalls.
- **Disconnect** in OBS unpairs only this OBS. Removing the channel
  everywhere asks first.
- When a pairing or Google sign-in stops working, OBS clears it, shows
  **Reconnect** and keeps the clip. A newer sign-in is never cleared. OBS also
  checks its app pairing at startup and when Settings opens, so disconnecting
  on the web shows **Reconnect** right away.
- Google sign-in from OBS can be cancelled or retried and shows why it failed.
- The settings window saves both pages together and keeps fields you didn't
  touch. Only one can be open, and **Test** checks only the selected
  destination.
- The dock shows the OBS buffer and Better Clips separately, offers **Retry**
  and setup buttons, and shows the last successful upload or test.
- The installers check the new plugin before replacing a working one and keep
  a rollback copy. Setup codes are validated first and only used up once
  saved. Settings are recovered from a backup when the main file is damaged.

## [0.3.2] - 2026-11-25

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

[0.5.0]: https://github.com/aarsh21/better-clips/releases/tag/0.5.0
[0.4.0]: https://github.com/aarsh21/better-clips/releases/tag/0.4.0
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
