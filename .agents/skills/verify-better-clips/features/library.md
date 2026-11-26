# Play and manage clips

## Sub-features

R2 playback, rename and nondestructive trim; YouTube rename, visibility, whole-second cut, permanent delete, web disconnect. R2 also offers Keep, share links, trash and restore.

## How to get to it (user POV)

Open a clip card. Click its title or press E to rename. R2 has a real video player and Trim; YouTube offers Cut and a visibility menu. Delete on R2 moves the clip to Trash; Delete from YouTube asks for confirmation before changing the channel.

## Driving it with agent-browser

Capture the library before opening a card. `"$S/drive" library "$id"` does so in `$E/library-before.png`, records `$E/dashboard.mp4`, opens Clip 2, checks two advancing `currentTime` readings, renames, and saves a trim as another file. Inspect `$E/player.png`, `$E/trim.png` and the reloaded card names in `$E/library-after.txt`.

`library` checks that UUIDs are absent from rendered card titles. It opens Empty trash for one clip, trashes a different clip in a second signed-in tab, then confirms the first tab's selection. Exactly the second clip must survive a reload (`trash-confirm.png`, `trash-survivor.png`).

After `channel`, `edit` submits a title and visibility change. Inspect `pending-title.png` and `pending-privacy.png` before the fake confirms them. The viewer and the stored title/privacy must agree after confirmation. Drag the cut endpoints to 2 and 8 seconds; Settings → YouTube → Disconnect must describe 1 entry, 2 cut points and 1 device. Cancel, delete the video, reload, then confirm disconnect: only the device count should remain in the confirmation. Inspect `$E/cut.png`, `$E/edited.txt`, `$E/disconnect-counts.png` and `$E/web-disconnected.png`.

For secondary R2 controls on `r2-$id`, take a before screenshot, get fresh `snapshot -i` refs, click a card's **Keep forever**, open **Kept**, find it by name. Click **Share** → **1 day**; expect “Link copied”. Paste into a blank tab as inert text as in `drive upgrade`, then open only the local `/s/` link. Click **Move to trash** → **Trash 1** → **Restore**; reload **All** and confirm the same title plays. Type `/`, fill the combobox with `Calibration`, and verify the options exclude unrelated clips. Capture the resulting cards and share page, without publishing a live capability link.

## Gotchas

A Worker/API PATCH alone doesn't test the editor. A cut changes playback boundaries, not the original YouTube bytes. A fake video ID can be ready in D1 while the real embed visibly says unavailable. Use the R2 player for local playback evidence and the owner-assisted path for YouTube playback. A rename invalidates queries; wait for the renamed viewer before interacting with the trim bar. R2 trim creates a new file at a keyframe; judge the visible duration, not whether every pre-cut byte was scrubbed.
