# Pair, upload and disconnect a YouTube channel

## Sub-features

Google sign-in, through-app browser pairing, direct desktop OAuth, review-before-upload, the clipboard link, asynchronous processing, and disconnect from both sides.

## How to get to it (user POV)

From a signed-out hosted dashboard use Sign in with Google. In OBS dock Settings choose YouTube → Through the Better Clips app → Sign in with YouTube. Click Save after connecting. For direct uploads, disconnect first, choose Directly to YouTube, sign in, choose review and click Save. Press the hotkey; in the review dialog click Upload.

## Driving it with xdotool and agent-browser

Capture the signed-out page before clicking Google. `"$S/drive" channel "$id"` saves `$E/google-before.png`, pairs through the same `yt-$id` browser via the lab's `scripts/xdg-open`, and checks the plugin reports **Local channel**. It clicks the actual dock, waits for the copied URL and a ready D1 row, then checks the ready message didn't replace the clipboard. Inspect `$E/paired.jpg`, `$E/host-upload.jpg`, `$E/ready.jpg` and the new card in `$E/hosted-library.png`.

After `edit` revokes via the web, `"$S/drive" direct "$id"` captures the stale OBS connection in `$E/direct-before.jpg`. It clears it from OBS, pairs directly, reviews a hotkey replay, and checks a **different** copied link without creating a D1 clip. The final OBS Disconnect must clear the refresh token and channel. Inspect `$E/review.jpg`, `$E/direct-uploaded.jpg` and `$E/direct-disconnected.jpg` alongside `$E/direct-link.txt`.

## Gotchas

Pairing uses an ephemeral OBS loopback callback. Open the actual URL from Qt; typing the dashboard home address does not pair. The fake requires the exact `test-client`/`test-secret`, and the three desktop overrides must be `http://127.0.0.1:9393`, not `localhost`. The app callback instead uses **localhost:8787** to match `CLIPS_TEST_ORIGIN`. Do not change hostnames halfway through sign-in. Routes are locked while connected. OBS may leave the review dialog behind its main window to avoid stealing focus. See SKILL.md for the real-Google run; the fake's lost replies and delayed processing are intentional.
