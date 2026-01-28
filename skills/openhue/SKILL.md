---
name: openhue
description: Control Philips Hue lights/scenes via the OpenHue CLI.
homepage: https://www.openhue.io/cli
metadata: {"moltbot":{"emoji":"💡","requires":{"bins":["openhue"]},"install":[{"id":"brew","kind":"brew","formula":"openhue/cli/openhue-cli","bins":["openhue"],"label":"Install OpenHue CLI (brew)"}]}}
---

# OpenHue CLI

Use `openhue` to control Hue lights and scenes via a Hue Bridge.

Setup
- Discover bridges: `openhue discover`
- Guided setup: `openhue setup`

Read
- `openhue get light --json`
- `openhue get room --json`
- `openhue get scene --json`

Write
- Turn on: `openhue set light <id-or-name> --on`
- Turn off: `openhue set light <id-or-name> --off`
- Brightness: `openhue set light <id> --on --brightness 50`
- Color: `openhue set light <id> --on --rgb #3399FF`
- Scene: `openhue set scene <scene-id>`

Notes
- You may need to press the Hue Bridge button during setup.
- Use `--room "Room Name"` when light names are ambiguous.
