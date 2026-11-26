# Save a replay to a bucket

## Sub-features

Better Clips app (R2) with the replay dock and migrated hotkey; S3 with API URL, keys, folder and optional public URL; Test Upload versus a real replay.

## How to get to it (user POV)

In the Better Clips dock, start the Replay Buffer, let it fill, then click Save Replay to R2. Press the plugin's Save Replay and Upload hotkey. Open dock Settings → Destination → S3 bucket, enter the bucket URL/keys and public URL, click Test Upload, Save, then Save Replay to S3.

## Driving it with xdotool

Start with `$E/r2-before.jpg` while the buffer runs. `"$S/drive" stores "$id"` records this and the real button/hotkey actions in `$E/obs.mp4`, then waits for two OBS upload receipts. It selects S3 in the Qt combo box and populates Moto's path-style `http://127.0.0.1:9394/clips` and the `verified` folder. Capture the settings, upload a third replay, read the **X11** clipboard (`xclip -sel clipboard -o`) and fetch that URL. Inspect `$E/r2-after.jpg`, `$E/stores.log` and `$E/s3-after.jpg` alongside the nonempty H.264/AAC MP4 reported in `$E/s3.log`.

`stores` checks that the dock distinguishes the two running buffers, reports the last successful upload, and opens settings from **Set up S3**. `length` trips a disposable OBS Lua fixture that stops only the Better Clips output. Click **Retry Better Clips Buffer**, verify both are running again, and save through the dock. With a warm buffer and 12 s selected, ffprobe must find a leading keyframe and a duration between 12 s and 12 s plus one measured keyframe gap. Repeat on a stopped-profile fixture with x264's keyframe interval set to 1 s. Expect one long-gap warning on the default arm and none on the 1 s arm. See `$E/keyframes.log`.

## Gotchas

OBS also has a native “Save Replay” action that writes to disk. The plugin has a different dock and binding. xdotool must hold the hotkey across OBS polling ticks (`keydown Shift_L keydown F8 sleep .25 keyup F8 keyup Shift_L`). A desired replay length isn't necessarily the exact output length: the plugin retains whole keyframes. A private S3 bucket accepting PUT doesn't imply public GET works. The lab sets GetObject policy on its disposable bucket and checks the returned bytes. Moto is not an AWS IAM/signature conformance test.
