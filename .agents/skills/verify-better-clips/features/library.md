# Play and manage clips

## Sub-features

R2 playback, rename and nondestructive trim; YouTube rename, visibility, whole-second cut, permanent delete, web disconnect. R2 also offers Keep, share links, trash and restore.

## How to get to it (user POV)

Open a clip card. Click its title or press E to rename. R2 has a real video player and Trim; YouTube offers Cut and a visibility menu. Delete on R2 moves the clip to Trash; Delete from YouTube asks for confirmation before changing the channel.

## Driving it with agent-browser

Capture the library before opening a card. `"$S/drive" library "$id"` does so in `$E/library-before.png`, records `$E/dashboard.mp4`, opens Clip 2, checks two advancing `currentTime` readings, renames, and saves a trim as another file. Inspect `$E/player.png`, `$E/trim.png` and the reloaded card names in `$E/library-after.txt`.

After `channel`, `"$S/drive" edit "$id"` captures `$E/edit-before.png` then opens the hosted clip, renames it Night practice, chooses Private, and drags both `[data-handle]` endpoints to 2 and 8 seconds. It confirms the D1 row, deletes from YouTube, confirms the library is empty, then uses Settings → YouTube → Disconnect YouTube → Disconnect. Inspect `$E/cut.png`, `$E/edited.txt` (`Night practice|private|2|8|ready`) and `$E/web-disconnected.png` against zero clips and zero linked channels.

For secondary R2 controls on `r2-$id`, take a before screenshot, get fresh `snapshot -i` refs, click a card's **Keep forever**, open **Kept**, find it by name. Click **Share** → **1 day**; expect “Link copied”. Paste into a blank tab as inert text as in `drive upgrade`, then open only the local `/s/` link. Click **Move to trash** → **Trash 1** → **Restore**; reload **All** and confirm the same title plays. Type `/`, fill the combobox with `Calibration`, and verify the options exclude unrelated clips. Capture the resulting cards and share page, without publishing a live capability link.

## Gotchas

A Worker/API PATCH alone doesn't test the editor. A cut changes playback boundaries, not the original YouTube bytes. A fake video ID can be ready in D1 while the real embed visibly says unavailable. Use the R2 player for local playback evidence and the owner-assisted path for YouTube playback. A rename invalidates queries; wait for the renamed viewer before interacting with the trim bar. R2 trim creates a new file at a keyframe; judge the visible duration, not whether every pre-cut byte was scrubbed.
