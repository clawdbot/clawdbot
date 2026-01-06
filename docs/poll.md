---
summary: "Poll sending via gateway + CLI"
read_when:
  - Adding or modifying poll support
  - Debugging poll sends from the CLI or gateway
---
# Polls

Updated: 2026-01-06

## Supported providers
- WhatsApp (web provider)
- Discord

## CLI

```bash
# WhatsApp
clawdbot poll --to +15555550123 -q "Lunch today?" -o "Yes" -o "No" -o "Maybe"
clawdbot poll --to 123456789@g.us -q "Meeting time?" -o "10am" -o "2pm" -o "4pm" -s 2

# Discord
clawdbot poll --to channel:123456789 -q "Snack?" -o "Pizza" -o "Sushi" --provider discord
clawdbot poll --to channel:123456789 -q "Plan?" -o "A" -o "B" --provider discord --duration-hours 48
```

Options:
- `--provider`: `whatsapp` (default) or `discord`
- `--max-selections`: how many choices a voter can select (default: 1)
- `--duration-hours`: Discord-only (defaults to 24 when omitted)

## Gateway RPC

Method: `poll`

Params:
- `to` (string, required)
- `question` (string, required)
- `options` (string[], required)
- `maxSelections` (number, optional)
- `durationHours` (number, optional)
- `provider` (string, optional, default: `whatsapp`)
- `idempotencyKey` (string, required)

## Provider differences
- WhatsApp: 2-12 options, `maxSelections` must be within option count, ignores `durationHours`.
- Discord: 2-10 options, `durationHours` clamped to 1-768 hours (default 24). `maxSelections > 1` enables multi-select; Discord does not support a strict selection count.

## Agent tool (Discord)
The Discord tool action `poll` still uses `question`, `answers`, optional `allowMultiselect`, `durationHours`, and `content`. The gateway/CLI poll model maps `allowMultiselect` to `maxSelections > 1`.

Note: Discord has no “pick exactly N” mode; `maxSelections` is treated as a boolean (`> 1` = multiselect).
