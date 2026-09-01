---
name: camsnap
description: "Capture frames or clips from RTSP/ONVIF cameras and local webcams, including USB pan/tilt/zoom control."
homepage: https://camsnap.ai
metadata:
  {
    "openclaw":
      {
        "emoji": "📸",
        "requires": { "bins": ["camsnap"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/camsnap",
              "bins": ["camsnap"],
              "label": "Install camsnap (brew)",
            },
          ],
      },
  }
---

# camsnap

Use `camsnap` to grab snapshots, clips, or motion events from configured cameras.

Setup

- Config file: `~/.config/camsnap/config.yaml`
- Add camera: `camsnap add --name kitchen --host 192.168.0.10 --user user --pass pass`

Common commands

- Discover: `camsnap discover --info`
- Snapshot: `camsnap snap kitchen --out shot.jpg`
- Clip: `camsnap clip kitchen --dur 5s --out clip.mp4`
- Motion watch: `camsnap watch kitchen --threshold 0.2 --action '...'`
- Doctor: `camsnap doctor --probe`

Local webcams (macOS)

- List devices: `camsnap devices`
- Snapshot from a local camera: `camsnap snap --device 0 --out webcam.jpg`
- PTZ position and ranges: `camsnap ptz status --device 0`
- Move a gimbal camera: `camsnap ptz goto --device 0 --pan 45 --tilt -18`
- Also `camsnap ptz move` (relative deltas) and `camsnap ptz home`.

Notes

- Requires `ffmpeg` on PATH.
- Prefer a short test capture before longer clips.
- PTZ needs macOS Camera permission: these cameras only service UVC controls while streaming, so `camsnap` holds a capture session open for the operation.
- Motion commands verify the settled position and exit non-zero if the camera did not reach it. On-camera AI framing can override manual positioning; disable tracking if moves keep missing.
