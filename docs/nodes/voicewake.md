---
summary: "Global voice wake words (Gateway-owned) and how they sync across nodes"
read_when:
  - Changing voice wake words behavior or defaults
  - Adding new node platforms that need wake word sync
title: "Voice wake"
---

OpenClaw treats **wake words as a single global list** owned by the **Gateway**.

- There are **no per-node custom wake words**.
- **Any node/app UI may edit** the list; changes are persisted by the Gateway and broadcast to everyone.
- macOS and iOS keep local **Voice Wake enabled/disabled** toggles (local UX + permissions differ).
- Android currently keeps Voice Wake off and uses a manual mic flow in the Voice tab.

## Storage (Gateway host)

Wake words are stored on the gateway machine at:

- `~/.openclaw/settings/voicewake.json`

Shape:

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## Protocol

### Methods

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` with params `{ triggers: string[] }` → `{ triggers: string[] }`

Notes:

- Triggers are normalized (trimmed, empties dropped). Empty lists fall back to defaults.
- Limits are enforced for safety (count/length caps).

### Events

- `voicewake.changed` payload `{ triggers: string[] }`

Who receives it:

- All WebSocket clients (macOS app, WebChat, etc.)
- All connected nodes (iOS/Android), and also on node connect as an initial “current state” push.

## Client behavior

### macOS app

- Uses the global list to gate `VoiceWakeRuntime` triggers.
- Editing “Trigger words” in Voice Wake settings calls `voicewake.set` and then relies on the broadcast to keep other clients in sync.

### iOS node

- Uses the global list for `VoiceWakeManager` trigger detection.
- Editing Wake Words in Settings calls `voicewake.set` (over the Gateway WS) and also keeps local wake-word detection responsive.

### Android node

- Voice Wake is currently disabled in Android runtime/Settings.
- Android voice uses manual mic capture in the Voice tab instead of wake-word triggers.

## Related

- [Talk mode](/nodes/talk)
- [Audio and voice notes](/nodes/audio)
- [Media understanding](/nodes/media-understanding)
