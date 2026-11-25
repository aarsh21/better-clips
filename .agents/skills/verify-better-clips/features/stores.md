# Save a replay to a bucket

## Sub-features

Better Clips app (R2) with the replay dock and migrated hotkey; S3 with API URL, keys, folder and optional public URL; Test Upload versus a real replay.

## How to get to it (user POV)

In the Better Clips dock, start the Replay Buffer, let it fill, then click Save Replay to R2. Press the plugin's Save Replay and Upload hotkey. Open dock Settings → Destination → S3 bucket, enter the bucket URL/keys and public URL, click Test Upload, Save, then Save Replay to S3.

## Driving it with xdotool

Start with `$E/r2-before.jpg` while the buffer runs. `"$S/drive" stores "$id"` records this and the real button/hotkey actions in `$E/obs.mp4`, then waits for two OBS upload receipts. It selects S3 in the Qt combo box and populates Moto's path-style `http://127.0.0.1:9394/clips` and the `verified` folder. Capture the settings, upload a third replay, read the **X11** clipboard (`xclip -sel clipboard -o`) and fetch that URL. Inspect `$E/r2-after.jpg`, `$E/stores.log` and `$E/s3-after.jpg` alongside the nonempty H.264/AAC MP4 reported in `$E/s3.log`.

## Gotchas

OBS also has a native “Save Replay” action that writes to disk. The plugin has a different dock and binding. xdotool must hold the hotkey across OBS polling ticks (`keydown Shift_L keydown F8 sleep .25 keyup F8 keyup Shift_L`). A desired replay length isn't necessarily the exact output length: the plugin retains whole keyframes. A private S3 bucket accepting PUT doesn't imply public GET works. The lab sets GetObject policy on its disposable bucket and checks the returned bytes. Moto is not an AWS IAM/signature conformance test.
