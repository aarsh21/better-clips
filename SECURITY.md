# Security policy

## Reporting a vulnerability

Please don't open a public issue for security problems. Report them privately
through [GitHub's security advisories](https://github.com/aarsh21/better-clips/security/advisories/new),
or by email to aarshpersonal@proton.me.

Include what's affected (the plugin, the self-hosted app or the hosted app),
how to reproduce it, and what an attacker could do. You'll get a reply within a
few days, and credit in the fix's release notes if you'd like it.

## Supported versions

Only the latest release of the plugin and the current `main` of the web app get
security fixes.

## What's in scope

- The plugin leaking a pairing token or Google credential, or uploading to the wrong channel.
- The clips app letting someone read, change or delete clips, share links or
  settings they don't own, or sign in as someone else.
- One account reaching another account’s videos or tokens, or the OAuth flow being abused.
- The install scripts running anything other than the official release.

Out of scope: attacks that require an already-leaked credential or encryption key, and denial of service through Cloudflare’s own limits.
