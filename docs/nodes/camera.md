---
summary: "Camera capture on iOS, Android, macOS, and Linux nodes for photos and short video clips"
read_when:
  - Adding or modifying camera capture on node platforms
  - Extending agent-accessible MEDIA temp-file workflows
title: "Camera capture"
---

OpenClaw supports camera capture for agent workflows on paired **iOS**, **Android**, **macOS**, and **Linux** nodes: capture a photo (`jpg`) or a short video clip (`mp4`, with optional audio) via Gateway `node.invoke`.

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

Like `canvas.*`, the iOS node only allows `camera.*` commands in the **foreground**. Background invocations return `NODE_BACKGROUND_UNAVAILABLE`.

### CLI helper

The easiest way to get media files is via the CLI helper, which writes decoded media to a temp file and prints the saved path.

```bash
openclaw nodes camera snap --node <id>                 # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

`nodes camera snap` defaults to `--facing both`, capturing both front and back to give the agent both views; pass `--device-id` with a single explicit facing (`both` is rejected when `--device-id` is set). Output files are temporary (in the OS temp directory) unless you build your own wrapper.

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

Like `canvas.*`, the Android node only allows `camera.*` commands in the **foreground**. Background invocations return `NODE_BACKGROUND_UNAVAILABLE: command requires foreground`.

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

`camera.snap` and `camera.clip` remain dangerous commands. Add them to `gateway.nodes.allowCommands` only when you intend to arm capture; enabling the plugin alone does not bypass Gateway policy.

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
