# Clips

The web app for [Replay to R2](../README.md): browse, trim, keep, delete and
share the clips OBS uploads to your Cloudflare R2 bucket. It's one Cloudflare
Worker (Hono) serving a React app, so the browser never sees bucket keys.

![The clips app in light mode](../docs/images/app-light.webp)

- **Browse:** clips grouped by day, with thumbnails, hover previews and search.
- **Trim:** pick in and out points on a filmstrip; the cut is saved as a new
  clip without re-encoding (Mediabunny, in the browser). Because it isn't
  re-encoded, the file starts at the keyframe before your in point, so up to
  a couple of seconds before it are still in the file, just not played.
  Don't rely on trimming to hide something before you share.
- **Keep, delete, restore:** kept clips stay forever; new clips and the trash
  are cleared after the number of days you pick in **Settings → Storage**
  (30 and 7 by default, or never for new clips).
- **Share:** links that expire after 1, 7 or 30 days, or never. Share pages
  embed as video in Discord and other apps.
- **Search:** `/` or `⌘K` opens a search box for clips (by name or day) and
  commands such as switching tabs or the theme.
- **Connect OBS:** **Settings → OBS** gives a one-line install command for
  macOS/Linux or Windows that installs the plugin and connects it, and turns
  green as soon as OBS checks in.
- **Light and dark:** switch in the header, in search, or in **Settings →
  Appearance**, which also has a System option.
- **Cleanup:** a daily job deletes old clips using the Storage settings.

Keyboard: `/` or `⌘K` search, `1` `2` `3` tabs, then in a clip `↑` `↓` or `H` `L`
previous and next, `←` `→` seek 5 seconds, `K` keep, `T` trim, `E` rename, `Del` delete, `Space` play. While
trimming: `I` `O` set in and out, `Enter` save, `Esc` cancel.

## Bucket layout

```
replays/<day>/<time>_<category>[__<name>].mp4
                                   from OBS, deleted after N days (Settings);
                                   the category is the app or scene, the
                                   name is one you give it in the app
saved/<day>/...                    kept clips, never deleted
trash/<day>/...                    deleted clips, purged after N days (Settings)
thumbs/<clip key>.jpg              made in the browser the first time a clip is seen
```

A self-hosted app also keeps its own state in the bucket: `shares/<id>.json`
for share links, and `config/salt`, `config/settings.json` and
`config/obs-seen`. The hosted app keeps that state in D1 instead.

## Two ways to run it

**Self-hosted** (`wrangler.jsonc`): one person, one bucket bound to the Worker,
and a password or Cloudflare Access to sign in. This is what the Deploy button
sets up.

**Hosted** (`wrangler.app.jsonc`, [`worker/hosted.ts`](worker/hosted.ts)):
one deployment serves many people. Everyone signs in with Cloudflare OAuth and
brings their own bucket, either one the app creates for them or one they
connect with a key that only works for that bucket. Accounts, share links and
settings live in D1, bucket keys are encrypted with `CREDS_KEY`, and videos load
straight from each person's bucket through short-lived signed links. Hosted mode
switches on when the `DB` binding and the `CREDS_KEY`, `OAUTH_CLIENT_ID` and
`OAUTH_CLIENT_SECRET` secrets are set.

Some guarantees the hosted app keeps:

- Share links are pinned to the recording and thumbnail they were made from, so
  replacing a file never changes what an old link shows.
- Uploads and moves never overwrite an existing clip.
- In a bucket you connect yourself, cleanup stays off until you confirm the
  lengths, and it only ever deletes `.mp4` clips in `replays/` and `trash/`.
- A tab still showing another account can't change anything.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aarsh21/obs-replay-r2/tree/main/web)

The button copies this folder into your GitHub account, creates the `clips`
bucket, and asks for `APP_PASSWORD`, the password you sign in with (12 or more
characters). The app runs on `clips.<you>.workers.dev`. OBS uploads through
the app with a token from **Settings → OBS**, so you
need no R2 API keys.

By hand:

```sh
pnpm install
pnpm wrangler secret put APP_PASSWORD
pnpm build && pnpm run deploy
```

To sign in with Cloudflare Access instead of a password, put the app behind an
Access application, then set `ACCESS_TEAM` and `ACCESS_AUD` (the application's
audience tag) as vars and `OWNER_EMAIL` as a secret. Keep `APP_PASSWORD` set
too: OBS's upload token is made from it. Add Bypass applications for
`<your domain>/s` (share links) and `<your domain>/api/upload` (OBS, which
checks its own token), or Access blocks them before they reach the app. A gitignored
`wrangler.local.jsonc` is a good place for your own domain and Access settings:
`pnpm build && pnpm wrangler deploy -c wrangler.local.jsonc`.

If you deploy more than one copy of the app in the same Cloudflare account,
give each one its own `namespace_id` under `ratelimits` in `wrangler.jsonc`,
so they don't share sign-in limits.

For local development, copy `.dev.vars.example` to `.dev.vars` and set a
password, or set `DEV_NO_AUTH=1` to skip sign-in. `pnpm dev` serves the app
against a local bucket.

## Checks

`pnpm check` runs TypeScript, ESLint, the vendored
[anti-slop](https://github.com/dmmulroy/anti-slop) Oxlint rules
(`tools/oxlint/anti-slop`) and [React Doctor](https://react.doctor), which
must score 100. GitHub Actions runs it, plus a build, on every change to
`web/`.

## Stack

React 19, TanStack Query, Tailwind CSS 4 and shadcn/ui on Base UI, built with
Vite. The Worker uses Hono, `jose` for Access tokens, `aws4fetch` for signed
R2 requests in hosted mode, and [Mediabunny](https://mediabunny.dev) trims in
the browser.
