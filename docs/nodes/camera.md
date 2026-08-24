---
summary: "Camera capture and macOS physical PTZ control on paired nodes"
read_when:
  - Adding or modifying camera capture on node platforms
  - Controlling a USB camera's physical pan, tilt, or zoom on macOS
  - Extending agent-accessible MEDIA temp-file workflows
title: "Camera capture"
---

OpenClaw supports camera capture for agent workflows on paired **iOS**, **Android**, **macOS**, and **Linux** nodes: capture a photo (`jpg`) or a short video clip (`mp4`, with optional audio) via Gateway `node.invoke`.

When a capture request includes `deviceId`, the selected camera must match that ID exactly. An unknown ID fails instead of capturing from a different camera; run `camera.list` to refresh device IDs, which change when cameras are reconnected.

The macOS app can also physically pan, tilt, and zoom supported USB UVC cameras. PTZ moves the camera hardware; it does not rotate, crop, or otherwise transform a captured image.

All camera access is gated behind a user-controlled setting per platform.

## iOS node

### iOS user setting

- iOS Settings tab → **Camera** → **Allow Camera** (`camera.enabled`).
  - Default: **on** (missing key is treated as enabled).
  - When off: `camera.*` commands return `CAMERA_DISABLED`.

### iOS commands (via Gateway `node.invoke`)

- `camera.list`
  - Response payload: `devices` — array of `{ id, name, position, deviceType }`.

- `camera.snap`
  - Params:
    - `facing`: `front|back` (default: `front`)
    - `maxWidth`: number (optional; default `1600`)
    - `quality`: `0..1` (optional; default `0.9`, clamped to `[0.05, 1.0]`)
    - `format`: currently `jpg`
    - `delayMs`: number (optional; default `0`, internally capped at `10000`)
    - `deviceId`: string (optional; from `camera.list`)
  - Response payload: `format: "jpg"`, `base64`, `width`, `height`.
  - Payload guard: photos are recompressed to keep the base64-encoded payload under 5MB.

- `camera.clip`
  - Params:
    - `facing`: `front|back` (default: `front`)
    - `durationMs`: number (default `3000`, clamped to `[250, 60000]`)
    - `includeAudio`: boolean (default `true`)
    - `format`: currently `mp4`
    - `deviceId`: string (optional; from `camera.list`)
  - Response payload: `format: "mp4"`, `base64`, `durationMs`, `hasAudio`.

### iOS foreground requirement

The iOS node only allows `camera.*` commands in the **foreground**. Background invocations return `NODE_BACKGROUND_UNAVAILABLE`.

### CLI helper

The easiest way to get media files is via the CLI helper, which writes decoded media to a temp file and prints the saved path.

```bash
openclaw nodes camera snap --node <id>                 # default: one node-selected photo
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera snap --node <id> --facing both   # front then back (2 saved paths)
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

Without `--facing`, `nodes camera snap` captures one photo using the node's default camera and labels the saved artifact `unknown`. On non-Linux nodes, `--facing both` captures front then back and prints two saved paths. `--device-id` is valid without `--facing`; on non-Linux nodes, it cannot be combined with `--facing both`. Linux always sends one facing-less request and labels the artifact `unknown`, regardless of `--facing`. Output files are temporary (in the OS temp directory) unless you build your own wrapper.

## Android node

### Android user setting

- Android Settings sheet → **Camera** → **Allow Camera** (`camera.enabled`).
  - **Fresh installs default to off.** Existing installs that predate this setting are migrated to **on** so upgrades do not silently lose previously working camera access.
  - When off: `camera.*` commands return `CAMERA_DISABLED: enable Camera in Settings`.

### Permissions

- `CAMERA` is required for both `camera.snap` and `camera.clip`; missing/denied permission returns `CAMERA_PERMISSION_REQUIRED`.
- `RECORD_AUDIO` is required for `camera.clip` when `includeAudio` is `true`; missing/denied permission returns `MIC_PERMISSION_REQUIRED`.

The app prompts for runtime permissions when possible.

### Android foreground requirement

The Android node only allows `camera.*` commands in the **foreground**. Background invocations return `NODE_BACKGROUND_UNAVAILABLE: command requires foreground`.

### Android commands (via Gateway `node.invoke`)

- `camera.list`
  - Response payload: `devices` — array of `{ id, name, position, deviceType }`.

- `camera.snap`
  - Params: `facing` (`front|back`, default `front`), `quality` (default `0.95`, clamped to `[0.1, 1.0]`), `maxWidth` (default `1600`), `deviceId` (optional; unknown id fails with `INVALID_REQUEST`).
  - Response payload: `format: "jpg"`, `base64`, `width`, `height`.
  - Payload guard: recompressed to keep base64 under 5MB (same budget as iOS).

- `camera.clip`
  - Params: `facing` (default `front`), `durationMs` (default `3000`, clamped to `[200, 60000]`), `includeAudio` (default `true`), `deviceId` (optional).
  - Response payload: `format: "mp4"`, `base64`, `durationMs`, `hasAudio`.
  - Payload guard: raw MP4 is capped at 18MB before base64 encoding; oversize clips fail with `PAYLOAD_TOO_LARGE` (reduce `durationMs` and retry).

## macOS app

### macOS user setting

The macOS companion app exposes a checkbox:

- **Settings → General → Allow Camera** (`openclaw.cameraEnabled`).
  - Default: **off**.
  - When off: camera requests return `CAMERA_DISABLED: enable Camera in Settings`.

### CLI helper (node invoke)

Use the main `openclaw` CLI to invoke camera commands on the macOS node.

```bash
openclaw nodes camera list --node <id>                     # list camera ids
openclaw nodes camera snap --node <id>                     # prints saved path
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s       # prints saved path
openclaw nodes camera clip --node <id> --duration-ms 3000   # prints saved path (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

- `openclaw nodes camera snap` defaults to `maxWidth=1600` unless overridden.
- `camera.snap` waits `delayMs` (default 2000ms, clamped to `[0, 10000]`) after warm-up/exposure settle before capturing.
- Photo payloads are recompressed to keep base64 under 5MB.

### macOS physical PTZ

Physical PTZ is implemented by the Mac app for USB cameras that expose standard UVC absolute pan/tilt or zoom controls. It uses the same **Allow Camera** setting as capture. Other node platforms do not advertise these commands.

Always pass an explicit `deviceId` returned by `camera.list`. OpenClaw never chooses a default camera for physical movement.

- `camera.ptz.status` reads the current position without moving the camera. Request: `{ "deviceId": "<camera-id>" }`.
  - The response contains only executable `pan`, `tilt`, and `zoom` axes under `axes`.
  - Pan and tilt values are degrees. Zoom values are percentages.
  - Each axis reports `current`, `min`, `max`, `step`, `unit`, `canSet`, and `canMove`. `default` appears only when the camera successfully reports a device default.
  - `canHome` is true only when every executable exposed axis has a real device-advertised default, so the complete home plan can be attempted.
- `camera.ptz.control` changes the camera hardware. Its closed operations are:
  - `{ "deviceId": "<camera-id>", "operation": "set", "target": { "panDegrees": 10, "tiltDegrees": -5, "zoomPercent": 40 } }`
  - `{ "deviceId": "<camera-id>", "operation": "move", "delta": { "panDegrees": 2, "zoomPercent": -5 } }`
  - `{ "deviceId": "<camera-id>", "operation": "home" }`

`set` and `move` require at least one finite axis value. Omitted axes remain unchanged, and move deltas for zoom are percentage points. `home` restores the device-advertised defaults; it returns `CAMERA_PTZ_UNSUPPORTED` without moving the camera when `canHome` is false. The Mac app clamps and snaps requested values to the camera's range and resolution; the response returns the post-operation `state` and lists changed request fields in `adjusted`. Requesting an unsupported axis returns `CAMERA_PTZ_AXIS_UNSUPPORTED`.

Both PTZ commands briefly open a live camera stream because supported cameras only service UVC controls while streaming. This activates the camera and its privacy indicator for the duration, including when `camera.ptz.status` only reads the position. Frames are not retained, and no photo, video, or file is produced.

Pan/tilt and zoom use separate hardware writes and cannot be atomic. OpenClaw verifies the resulting position through a fresh control connection. If a later write or final status read fails, or an axis does not reach its requested position within the camera's reported resolution, `CAMERA_PTZ_PARTIAL` names the acknowledged control groups, includes the independently observed state when readable, and tells the caller to run `camera.ptz.status` before retrying. Position failures also report the requested and observed values; check that a video stream reaches the camera and disable on-camera AI framing or tracking that can override UVC controls.

`camera.ptz.control` is dangerous and remains disarmed until the operator explicitly adds it to `gateway.nodes.commands.allow`:

```json5
{
  gateway: {
    nodes: {
      commands: { allow: ["camera.ptz.control"] },
    },
  },
}
```

The allow entry alone does not widen an existing node approval. After the updated Mac reconnects and declares PTZ control, run `openclaw nodes pending`, then approve the widened surface with `openclaw nodes approve <requestId>`.

In the agent `nodes` tool, use `action: "camera_ptz"`, the selected Mac node, `deviceId`, and `ptzOperation: "status" | "set" | "move" | "home"`. Axis inputs are `panDegrees`, `tiltDegrees`, and `zoomPercent`.

## Linux node host

The bundled Linux Node plugin adds camera capture to the CLI `openclaw node` service. It works on a headless host and does not require the Linux desktop app.

Camera access defaults to off. Enable it under the plugin entry, then restart the node service so its Gateway advertisement is rebuilt:

```json5
{
  plugins: {
    entries: {
      "linux-node": {
        config: {
          camera: { enabled: true },
        },
      },
    },
  },
}
```

Requirements:

- FFmpeg with V4L2 input, `libx264`, and AAC support
- a `/dev/video*` device readable by the node-service user; on common distributions, add that user to the `video` group
- for clips with the default `includeAudio: true`, a working PulseAudio server or PipeWire PulseAudio compatibility layer with a default source

Linux returns capture-capable, readable V4L2 device paths from `camera.list`; FFmpeg probes each `/dev/video*` candidate and omits metadata or output-only nodes. Device `position` is `unknown`, so facing requests without `deviceId` produce one `unknown`-position photo or clip instead of claiming a front or back camera. Use `deviceId` when a host has multiple cameras. `camera.snap` uses FFmpeg input warm-up for `delayMs` and preserves aspect ratio while limiting width. `camera.clip` records microphone audio as the MP4 audio track; OpenClaw deliberately exposes no standalone microphone command.

The plugin uses `libx264` for MP4 video and does not silently change codecs. An FFmpeg build without the required input or encoders returns `CAMERA_UNAVAILABLE`. Photos and clips that would exceed the 25MB base64 payload budget fail with `PAYLOAD_TOO_LARGE`.

`camera.snap` and `camera.clip` remain dangerous commands. Add them to `gateway.nodes.commands.allow` only when you intend to arm capture; enabling the plugin alone does not bypass Gateway policy.

## Safety + practical limits

- Camera and microphone access trigger the usual OS permission prompts (and require usage strings in `Info.plist`).
- Video clips are capped at 60s to avoid oversized node payloads (base64 overhead plus message limits).

## macOS screen video (OS-level)

For _screen_ video (not camera), use the macOS companion:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints saved path
```

Requires macOS **Screen Recording** permission (TCC).

## Related

- [Image and media support](/nodes/images)
- [Media understanding](/nodes/media-understanding)
- [Location command](/nodes/location-command)
