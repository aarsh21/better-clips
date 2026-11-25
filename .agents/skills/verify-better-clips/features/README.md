# Better Clips user paths

Use the run ID and `$E=.amp/in/artifacts/bc-$id/` from SKILL.md. Chapters deliberately share one account and library; don't start a chapter halfway through a failed run without checking its preconditions.

| Path | Chapter | Decisive evidence |
| --- | --- | --- |
| [Install, pair R2 and upgrade](install.md) | `upgrade` | Both real OBS loader versions; same token and custom binding; old binary removed |
| [Capture to R2 and S3](stores.md) | `stores` | Two distinct R2 uploads; the copied S3 URL returns a decodable MP4 |
| [Open and edit clips](library.md) | `library`, then `edit` after `channel` | Advancing player, new R2 trim, YouTube privacy/cut row and confirmed deletion |
| [Pair and save to YouTube](youtube.md) | `channel`, `direct` | OBS browser callbacks, distinct copied links, processing completion and both disconnects |
| [OAuth, retries and missing Qt TLS](transport.md) | `lab protocol` | Upload probe's byte comparisons; Qt TLS disabled while the plugin receives an HTTPS response |
