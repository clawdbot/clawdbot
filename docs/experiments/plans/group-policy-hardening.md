---
summary: "Telegram allowlist hardening: prefix + whitespace normalization"
read_when:
  - Reviewing historical Telegram allowlist changes
---
# Telegram Allowlist Hardening

**Date**: 2026-01-05  
**Status**: Complete  
**PR**: #216

## Summary

Telegram allowlists now accept `telegram:` and `tg:` prefixes case-insensitively, and tolerate
accidental whitespace. This aligns inbound allowlist checks with outbound send normalization.

## What changed

- Prefixes `telegram:` and `tg:` are treated the same (case-insensitive).
- Allowlist entries are trimmed; empty entries are ignored.

## Examples

All of these are accepted for the same ID:

- `telegram:123456`
- `TG:123456`
- ` tg:123456 `

## Why it matters

Copy/paste from logs or chat IDs often includes prefixes and whitespace. Normalizing avoids
false negatives when deciding whether to respond in DMs or groups.

## Related docs

- [Group Chats](/concepts/groups)
- [Telegram Provider](/channels/telegram)
