# Install and upgrade without losing settings

## Sub-features

Password sign-in; Connect OBS; local .deb install; carry forward destination, token, folder and a non-default hotkey after the plugin rename.

## How to get to it (user POV)

Open the empty Better Clips library, sign in and copy its install command. Quit OBS before upgrading. Reopen OBS and check the Better Clips dock and its Settings button.

## Driving it with agent-browser and xdotool

Start with the password form before-capture. `"$S/drive" upgrade "$id"` records it in `$E/before-login.png`, signs in, and pastes the copied command into an inert blank tab to extract the setup code without executing a downloaded script. It boots the actual published legacy binary, dismisses the wizard, and exits OBS. `R=... scripts/scene.py` seeds a looping calibration reel in the **empty, stopped** scene for later saves; the chapter calls it automatically. The legacy setup file mimics an old installer handoff. The custom fixture binds Shift+F8, not the new default. The old OBS instance consumes the setup and saves settings before `lab upgrade` installs the candidate. Compare both plugin configs without printing secrets, check the old install directory is gone, then inspect `$E/legacy.jpg`, `$E/upgraded.jpg`, `$E/install.log` and `$E/upgrade.log`. The next chapter actually presses the migrated binding.

## Gotchas

OBS can overwrite edits made while running. `plugin_config/obs-replay-r2/config.json` → `plugin_config/better-clips/config.json` contains `save_hotkey`; the OBS profile only holds the replay-buffer/encoder settings. Keeping the old **config** is not leaving the old **plugin** installed. Discard neither user's config to force migration. Fresh OBS opens an Auto-Configuration Wizard, sometimes over a No Sources prompt. Wait for “Copied” before pasting: clicking Copy starts an asynchronous setup-code refresh.
