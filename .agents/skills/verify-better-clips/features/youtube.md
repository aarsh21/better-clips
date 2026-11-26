# Pair, upload and disconnect a YouTube channel

## Sub-features

Google sign-in, through-app browser pairing, direct desktop OAuth, review-before-upload, the clipboard link, asynchronous processing, and disconnect from both sides.

## How to get to it (user POV)

From a signed-out hosted dashboard use Sign in with Google. In OBS dock Settings choose YouTube → Through the Better Clips app → Sign in with YouTube. Click Save after connecting. For direct uploads, disconnect first, choose Directly to YouTube, sign in, choose review and click Save. Press the hotkey; in the review dialog click Upload.

## Driving it with xdotool and agent-browser

Capture the signed-out page before clicking Google. `"$S/drive" channel "$id"` saves `$E/google-before.png`, pairs through the same `yt-$id` browser via the lab's `scripts/xdg-open`, and checks the plugin reports **Local channel**. It clicks the actual dock, waits for the copied URL and a ready D1 row, then checks the ready message didn't replace the clipboard. Inspect `$E/paired.jpg`, `$E/host-upload.jpg`, `$E/ready.jpg` and the new card in `$E/hosted-library.png`.

`channel` cancels and confirms **Remove channel from app…**. It pairs two real OBS identities by restarting with a never-paired config. **Unpair this OBS** must preserve the other device and channel. Remove a listed device on the web; removing the current device and saving before reopening Settings exercises the upload-401 path. Pair again. Check Save/Cancel bounds and wheel the form at 1440×900 and 1366×768. For a successful upload the chapter probes the local recovery MP4 while processing and requires the same file to disappear on ready (`recovery.log`).

After `edit` revokes via the web, `direct` opens OBS Settings **without saving another clip**. Require **Not connected** and **Reconnect YouTube** on hosted; switching to never-paired direct must offer **Sign in with YouTube**. Pair directly, check the review checkbox (the drawn indicator must change, not just its accessibility state), review a hotkey save, and require a different copied link without a D1 row. The final OBS Disconnect must clear the refresh token and channel. Inspect `$E/hosted-unpaired.jpg`, `$E/review-checked.jpg`, `$E/review.jpg` and `$E/direct-uploaded.jpg`.

## Gotchas

Pairing uses an ephemeral OBS loopback callback. Open the actual URL from Qt; typing the dashboard home address does not pair. The fake requires the exact `test-client`/`test-secret`, and the three desktop overrides must be `http://127.0.0.1:9393`, not `localhost`. The app callback instead uses **localhost:8787** to match `CLIPS_TEST_ORIGIN`. Do not change hostnames halfway through sign-in. Routes are locked while connected. OBS may leave the review dialog behind its main window to avoid stealing focus. See SKILL.md for the real-Google run; the fake's lost replies and delayed processing are intentional.
