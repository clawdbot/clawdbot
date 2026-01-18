---
name: soul-evil
description: "Swap SOUL.md with SOUL_EVIL.md during a purge window or by random chance"
homepage: https://docs.clawd.bot/hooks/soul-evil
metadata:
  {
    "clawdbot":
      {
        "emoji": "😈",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["hooks.internal.entries.soul-evil.enabled"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with Clawdbot" }],
      },
  }
---

# SOUL Evil Hook

Replaces the injected `SOUL.md` content with `SOUL_EVIL.md` during a daily purge window or by random chance.

## What It Does

When enabled and the trigger conditions match, the hook swaps the **injected** `SOUL.md` content before the system prompt is built. It does **not** modify files on disk.

## Files

- `SOUL.md` — normal persona (always read)
- `SOUL_EVIL.md` — alternate persona (read only when triggered)

You can change the filename via hook config.

## Configuration

Add this to your config (`~/.clawdbot/clawdbot.json`):

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

### Options

- `file` (string): alternate SOUL filename (default: `SOUL_EVIL.md`)
- `chance` (number 0–1): random chance per run to swap in SOUL_EVIL
- `purge.at` (HH:mm): daily purge window start time (24h)
- `purge.duration` (duration): window length (e.g. `30s`, `10m`, `1h`)

**Precedence:** purge window wins over chance.

## Requirements

- `hooks.internal.entries.soul-evil.enabled` must be set to `true`

## Enable

```bash
clawdbot hooks enable soul-evil
```
