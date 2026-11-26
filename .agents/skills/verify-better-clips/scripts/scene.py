#!/usr/bin/env python3
"""Populate the run's empty OBS scene with a looping, changing video."""
import json
import os
from pathlib import Path
import subprocess
import uuid

if subprocess.run(["pgrep", "-x", "obs"], stdout=subprocess.DEVNULL).returncode == 0:
    raise SystemExit("Quit OBS before changing its scene")
root = Path(os.environ["R"]).resolve()
scene = root / "config/obs-studio/basic/scenes/Untitled.json"
data = json.loads(scene.read_text())
assert len(data["sources"]) == 1 and not data["sources"][0]["settings"]["items"], "Expected an empty disposable scene"
media = root / "calibration.mp4"
subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24", "-t", "8", "-c:v", "libx264", "-threads", "2", str(media)], check=True)
name = "Calibration reel"
uid = str(uuid.uuid4())
data["sources"].insert(0, {"name": name, "uuid": uid, "id": "ffmpeg_source", "versioned_id": "ffmpeg_source", "settings": {"is_local_file": True, "local_file": str(media), "looping": True}})
data["sources"][1]["settings"].update(id_counter=1, items=[{"name": name, "source_uuid": uid, "id": 1, "visible": True, "scale": {"x": 1, "y": 1}, "align": 5}])
# Fault fixture: stop only the plugin output; OBS's own replay buffer stays armed.
# Recovery itself must use the dock button, never this script.
lua = root / "stop-output.lua"
lua.write_text('''function trip()
  local marker = script_path() .. "stop-output"
  local f = io.open(marker, "r")
  if not f then return end
  f:close()
  os.remove(marker)
  local out = obslua.obs_get_output_by_name("Better Clips")
  if out then obslua.obs_output_force_stop(out); obslua.obs_output_release(out) end
end
function script_load(settings) obslua.timer_add(trip, 200) end
''')
data["modules"]["scripts-tool"].append({"path": str(lua), "settings": {}})
scene.write_text(json.dumps(data))
