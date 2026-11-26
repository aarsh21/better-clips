# Better Clips user paths

The dashboard is at `/apps/` on both Workers; the hosted `/` is the public homepage and the self-hosted `/` redirects to `/apps/`. Old `/#/clip/…`, `/?auth_error=` and `/?connected=` links forward to `/apps/`; Google and Cloudflare sign-in return there. Every Google sign-in or YouTube connect opens a disclosure first (**Continue** goes on to Google). `/faq`, `/privacy` and `/terms` are public. Big headings use an uppercase display face, so `wait --text` sees them in capitals (`NO CLIPS YET`).

Use the run ID and `$E=.amp/in/artifacts/bc-$id/` from SKILL.md. Chapters deliberately share one account and library; don't start a chapter halfway through a failed run without checking its preconditions.

| Path | Chapter | Decisive evidence |
| --- | --- | --- |
| [Install, pair R2 and upgrade](install.md) | `upgrade` | Both real OBS loader versions; same token and custom binding; old binary removed |
| [Capture to R2 and S3](stores.md) | `stores`, `length` | Button and hotkey uploads, dock setup/retry, ffprobe window bounds and warnings on two encoder profiles |
| [Open and edit clips](library.md) | `library`, then `edit` after `channel` | Advancing player, new R2 trim, YouTube privacy/cut row and confirmed deletion |
| [Pair and save to YouTube](youtube.md) | `channel`, `player`, `direct`, `credentials` | Recovery before choosing an audience; both uploads; three player states; direct token migration, restart and session-only fallback |
| [OAuth, retries and missing Qt TLS](transport.md) | `lab protocol` | Upload probe's byte comparisons; Qt TLS disabled while the plugin receives an HTTPS response |
