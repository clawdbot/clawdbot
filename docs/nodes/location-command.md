---
summary: "Location command for nodes (location.get), permission modes, and background behavior"
read_when:
  - Adding location node support or permissions UI
  - Designing background location + push flows
---

# Location command (nodes)

## TL;DR
- `location.get` is a node command (via `node.invoke`).
- Off by default.
- Settings use a selector: Off / While Using / Always.
- Separate toggle: Precise Location.

## Why a selector (not just a switch)
OS permissions are multi-level. We can expose a selector in-app, but the OS still decides the actual grant.
- iOS/macOS: user can choose **While Using** or **Always** in system prompts/Settings. App can request upgrade, but OS may require Settings.
- Android: background location is a separate permission; on Android 10+ it often requires a Settings flow.
- Precise location is a separate grant (iOS 14+ “Precise”, Android “fine” vs “coarse”).

Selector in UI drives our requested mode; actual grant lives in OS settings.

## Settings model
Per node device:
- `location.enabledMode`: `off | whileUsing | always`
- `location.preciseEnabled`: bool

UI behavior:
- Selecting `whileUsing` requests foreground permission.
- Selecting `always` first ensures `whileUsing`, then requests background (or sends user to Settings if required).
- If OS denies requested level, revert to the highest granted level and show status.

## Permissions mapping (node.permissions)
Optional. macOS node reports `location` via the permissions map; iOS/Android may omit it.

## Command: `location.get`
Called via `node.invoke`.

Params (suggested):
```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

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
- `LOCATION_BACKGROUND_UNAVAILABLE`: app is backgrounded but only While Using allowed.
- `LOCATION_TIMEOUT`: no fix in time.
- `LOCATION_UNAVAILABLE`: system failure / no providers.

## Background behavior (future)
Goal: model can request location even when node is backgrounded, but only when:
- User selected **Always**.
- OS grants background location.
- App is allowed to run in background for location (iOS background mode / Android foreground service or special allowance).

Push-triggered flow (future):
1) Gateway sends a push to the node (silent push or FCM data).
2) Node wakes briefly and requests location from the device.
3) Node forwards payload to Gateway.

Notes:
- iOS: Always permission + background location mode required. Silent push may be throttled; expect intermittent failures.
- Android: background location may require a foreground service; otherwise, expect denial.

## Model/tooling integration
- Tool surface: `nodes` tool adds `location_get` action (node required).
- CLI: `moltbot nodes location get --node <id>`.
- Agent guidelines: only call when user enabled location and understands the scope.

## UX copy (suggested)
- Off: “Location sharing is disabled.”
- While Using: “Only when Moltbot is open.”
- Always: “Allow background location. Requires system permission.”
- Precise: “Use precise GPS location. Toggle off to share approximate location.”
