---
summary: "Global voice wake words (Gateway-owned) and how they sync across nodes"
read_when:
  - Changing voice wake words behavior or defaults
  - Adding new node platforms that need wake word sync
title: "Voice wake"
---

Wake words are **one global list owned by the Gateway** — there are no per-node custom lists. Any node or app UI can edit the list; the Gateway persists the change and broadcasts it to every connected client.

- **macOS**: local Voice Wake enable/disable toggle. Requires macOS 26+; see [Voice wake (macOS)](/platforms/mac/voicewake) for runtime/PTT details.
- **iOS**: local Voice Wake enable/disable toggle in Settings.
- **Android**: local Voice Wake enable/disable toggle and wake-word editor in Settings → Voice. Requires Android on-device speech recognition.

## Storage

Wake words and routing rules live in the Gateway state database, `~/.openclaw/state/openclaw.sqlite` by default (override with `OPENCLAW_STATE_DIR`), tables `voicewake_triggers`, `voicewake_routing_config`, `voicewake_routing_routes`. Legacy `settings/voicewake.json` and `settings/voicewake-routing.json` are `openclaw doctor --fix` migration inputs only — runtime never reads them.

## Protocol

### Trigger list

| Method          | Params                   | Result                   |
| --------------- | ------------------------ | ------------------------ |
| `voicewake.get` | none                     | `{ triggers: string[] }` |
| `voicewake.set` | `{ triggers: string[] }` | `{ triggers: string[] }` |

`voicewake.set` normalizes input: trims whitespace, drops empty entries, keeps at most 32 triggers, and truncates each to 64 UTF-16 code units without splitting surrogate pairs. An empty result falls back to the built-in defaults (`openclaw`, `claude`, `computer`).

### Routing (trigger to target)

| Method                  | Params                               | Result                               |
| ----------------------- | ------------------------------------ | ------------------------------------ |
| `voicewake.routing.get` | none                                 | `{ config: VoiceWakeRoutingConfig }` |
| `voicewake.routing.set` | `{ config: VoiceWakeRoutingConfig }` | `{ config: VoiceWakeRoutingConfig }` |

```json
{
  "version": 1,
  "defaultTarget": { "mode": "current" },
  "routes": [{ "trigger": "robot wake", "target": { "sessionKey": "agent:main:main" } }],
  "updatedAtMs": 1730000000000
}
```

Each route `target` supports exactly one of:

- `{ "mode": "current" }`
- `{ "agentId": "main" }`
- `{ "sessionKey": "agent:main:main" }`

Limits: at most 32 routes, trigger text at most 64 characters. Route triggers are normalized for matching and duplicate detection by lowercasing, stripping leading/trailing punctuation from each word, and collapsing whitespace (`"Hey, Bot!!"` and `"hey bot"` match and count as duplicates) — this is a stricter normalization than the plain trim used for the global trigger list above.

### Events

| Event                       | Payload                              |
| --------------------------- | ------------------------------------ |
| `voicewake.changed`         | `{ triggers: string[] }`             |
| `voicewake.routing.changed` | `{ config: VoiceWakeRoutingConfig }` |

Both broadcast to every WebSocket client with read scope (macOS app, WebChat, and similar) and to every connected node. A node also gets both as an initial snapshot push right after it connects.

## Client behavior

- **macOS**: calls `voicewake.set`/`voicewake.get` and listens for `voicewake.changed` to stay in sync with other clients.
- **iOS**: calls `voicewake.set`/`voicewake.get` and listens for `voicewake.changed` to keep local wake-word detection responsive.
- **Android**: calls `voicewake.set`/`voicewake.get`, listens for `voicewake.changed`, and advertises `voiceWake` while enabled. Recognition stays on-device and foreground-only; it pauses while Talk, manual dictation, voice-note capture, or message speech owns audio.

## Related

- [Talk mode](/nodes/talk)
- [Audio and voice notes](/nodes/audio)
- [Media understanding](/nodes/media-understanding)
