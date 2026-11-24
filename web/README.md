# Clips

The web app for Replay to R2: browse, trim, keep, delete and share the clips
OBS uploads to your Cloudflare R2 bucket. It is a single Cloudflare Worker
next to the bucket, so the browser never sees bucket keys.

- **Browse:** clips grouped by day, with thumbnails, hover previews and search.
- **Trim:** pick in and out points on a filmstrip; the cut is saved as a new
  clip without re-encoding (Mediabunny, in the browser).
- **Keep, delete, restore:** recent clips are cleared after 30 days, the trash
  after 7. Kept clips stay forever.
- **Share:** links that expire after 1, 7 or 30 days, or never. Share pages
  embed as video in Discord and other apps.
- **Connect OBS:** copies a setup code the plugin pastes in one click.

Keyboard: `/` search, `1` `2` `3` tabs, then in a clip `←` `→` next and
previous, `K` keep, `T` trim, `E` rename, `Del` delete, `Space` play. While
trimming: `I` `O` set in and out, `Enter` save, `Esc` cancel.

## Bucket layout

```
replays/<day>/<time>_<scene>.mp4   from OBS, deleted after 30 days
saved/<day>/...                    kept clips, never deleted
trash/<day>/...                    deleted clips, purged after 7 days
thumbs/<clip key>.jpg              made in the browser the first time a clip is seen
shares/<id>.json                   share links
```

## Deploy

Sign-in is Cloudflare Access (one-time code to the owner's email); share
links under `/s/` bypass it. `wrangler.jsonc` holds the domain, Access team and
audience. The owner's email and the plugin's upload keys are Worker secrets:

```sh
pnpm install
pnpm wrangler secret put OWNER_EMAIL
pnpm wrangler secret put OBS_ACCESS_KEY_ID
pnpm wrangler secret put OBS_SECRET_ACCESS_KEY
pnpm run deploy
```

For local development, `.dev.vars` with `DEV_NO_AUTH=1` skips the sign-in
check, and `pnpm dev` serves the app against a local bucket.

## Checks

`pnpm check` runs TypeScript, ESLint, the vendored
[anti-slop](https://github.com/dmmulroy/anti-slop) Oxlint rules
(`tools/oxlint/anti-slop`) and [React Doctor](https://react.doctor), which
must score 100.
