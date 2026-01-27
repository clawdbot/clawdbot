---
summary: "SOUL Evil hook (swap SOUL.md with SOUL_EVIL.md)"
read_when:
  - You want to enable or tune the SOUL Evil hook
  - You want a purge window or random-chance persona swap
---

# SOUL Evil Hook

The SOUL Evil hook swaps the **injected** `SOUL.md` content with `SOUL_EVIL.md` during
a purge window or by random chance. It does **not** modify files on disk.

## How It Works

When `agent:bootstrap` runs, the hook can replace the `SOUL.md` content in memory
before the system prompt is assembled. If `SOUL_EVIL.md` is missing or empty,
Moltbot logs a warning and keeps the normal `SOUL.md`.

Sub-agent runs do **not** include `SOUL.md` in their bootstrap files, so this hook
has no effect on sub-agents.

## Enable

```bash
moltbot hooks enable soul-evil
```

Then set the config:

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

Create `SOUL_EVIL.md` in the agent workspace root (next to `SOUL.md`).

## Options

- `file` (string): alternate SOUL filename (default: `SOUL_EVIL.md`)
- `chance` (number 0–1): random chance per run to use `SOUL_EVIL.md`
- `purge.at` (HH:mm): daily purge start (24-hour clock)
- `purge.duration` (duration): window length (e.g. `30s`, `10m`, `1h`)

**Precedence:** purge window wins over chance.

**Timezone:** uses `agents.defaults.userTimezone` when set; otherwise host timezone.

## Notes

- No files are written or modified on disk.
- If `SOUL.md` is not in the bootstrap list, the hook does nothing.

## See Also

- [Hooks](/hooks)
