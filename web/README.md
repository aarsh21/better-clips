# Better Clips dashboard

Sign in with Google at `/apps/` to manage clips uploaded through the app. The Worker creates the resumable upload, but OBS sends the file straight to YouTube. D1 holds accounts, encrypted Google credentials, paired devices and library metadata. Direct OBS uploads do not create a library entry.

The dashboard can rename a video, change its visibility, copy its link or delete it after confirmation. Download opens the video in YouTube Studio; Better Clips does not fetch the video file. Only videos confirmed not made for kids are embedded here.

## Local development

From `web/`, run `pnpm install`. Copy `.dev.vars.example` to `.dev.vars`. Set a stable `CREDS_KEY` and the credentials for a Google Web OAuth client with the exact `/api/youtube/callback` redirect URI. Use the project verification skill for a fully local fake instead.

Run `pnpm exec wrangler d1 migrations apply clips-app --local -c wrangler.app.jsonc`, then `pnpm dev`. For your own deployment, use a D1 database and OAuth client you control; replace the account and database IDs in `wrangler.app.jsonc`. Never commit the secrets.

## Checks

`pnpm check` runs TypeScript, ESLint, Oxlint and React Doctor (100/100). `pnpm build` builds the Worker and the React app.
