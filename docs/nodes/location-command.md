---
summary: "Location command for nodes, platform permission modes, and Linux GeoClue setup"
read_when:
  - Adding location node support or permissions UI
  - Designing Android location permissions or foreground behavior
title: "Location command"
---

## TL;DR

- `location.get` is a node command, invoked via `node.invoke` or `openclaw nodes location get`.
- Off by default.
- Android third-party builds use a selector: Off / While Using / Always. Play builds remain Off / While Using.
- Precise Location is a separate toggle.

## Why a selector (not just a switch)

OS location permissions are multi-level. Precise location is a separate OS grant too (iOS 14+ "Precise", Android "fine" vs "coarse"). The in-app selector drives the requested mode, but the OS still decides the actual grant.

## Settings model

Per node device:

- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

UI behavior:

- Selecting `whileUsing` requests foreground permission.
- Selecting `always` in the Android third-party build first requests foreground permission, explains the background access, then opens Android app settings for the separate **Allow all the time** grant.
- Android Play builds do not declare background location permission or show `always`.
- If the OS denies the requested level, the app reverts to the highest granted level and shows status.

## Permissions mapping (node.permissions)

Optional. The macOS node reports `location` via the `permissions` map on `node.list`/`node.describe`; iOS/Android may omit it.

## Command: `location.get`

Called via `node.invoke`, or the CLI helper:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Params:

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

CLI flags map directly: `--location-timeout` -> `timeoutMs`, `--max-age` -> `maxAgeMs`, `--accuracy` -> `desiredAccuracy`.

Response payload:

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

Errors (stable codes):

- `LOCATION_DISABLED`: selector is off.
- `LOCATION_PERMISSION_REQUIRED`: permission missing for requested mode.
- `LOCATION_BACKGROUND_UNAVAILABLE`: app is backgrounded but only While Using is granted.
- `LOCATION_TIMEOUT`: no fix in time.
- `LOCATION_UNAVAILABLE`: system failure or no providers.

## Background behavior

- Android third-party builds accept background `location.get` only when the user selected `Always` and Android granted background location. The existing persistent node service adds the `location` service type and discloses `Location: Always` while active.
- Android Play builds and `While Using` mode deny `location.get` while backgrounded.
- Other node platforms may differ.

## Linux node host

The bundled Linux Node plugin adds `location.get` to the CLI `openclaw node` service, including headless hosts without the Linux desktop app. Location defaults to off. Enable it under the plugin entry, then restart the node service:

```json5
{
  plugins: {
    entries: {
      "linux-node": {
        config: {
          location: { enabled: true },
        },
      },
    },
  },
}
```

Install GeoClue2 and its `where-am-i` demo (`geoclue-2-demo` on Debian and Ubuntu). The node-service user must be allowed by the host's GeoClue policy and authorization agent.

The plugin uses `where-am-i` instead of a sequence of `busctl` calls. GeoClue ties client creation, properties, start, updates, and stop to one D-Bus client connection; the demo keeps that lifecycle together while separate `busctl` subprocesses do not. No npm dependency is added.

Linux maps `coarse`, `balanced`, and `precise` to GeoClue accuracy levels `4`, `6`, and `8`. It validates `maxAgeMs` against the returned timestamp. GeoClue's demo does not expose the selected provider, so `source` is `unknown`; `isPrecise` is true only when reported accuracy is 100 meters or better.

Linux uses the same stable errors: `LOCATION_DISABLED`, `LOCATION_TIMEOUT`, and `LOCATION_UNAVAILABLE`.

## Model/tooling integration

- Agent tool: the `nodes` tool's `location_get` action (node required).
- CLI: `openclaw nodes location get --node <id>`.
- Agent guidelines: only call when the user enabled location and understands the scope.

## UX copy (suggested)

- Off: "Location sharing is disabled."
- While Using: "Only when OpenClaw is open."
- Always: "Allow requested location checks while OpenClaw is in the background."
- Precise: "Use precise GPS location. Toggle off to share approximate location."

## Related

- [Nodes overview](/nodes)
- [Channel location parsing](/channels/location)
- [Camera capture](/nodes/camera)
- [Talk mode](/nodes/talk)
