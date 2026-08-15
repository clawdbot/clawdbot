---
summary: "OpenClaw logging: rolling diagnostics file log + unified log privacy flags"
read_when:
  - Capturing macOS logs or investigating private data logging
  - Debugging voice wake/session lifecycle issues
title: "macOS logging"
---

# Logging (macOS)

## Rolling diagnostics file log (Debug pane)

The macOS app logs through swift-log (unified logging by default) and can also write a rotating local file log for durable capture (`DiagnosticsFileLog`).

- Enable: **Debug pane -> Logs -> App logging -> "Write rolling diagnostics log (JSONL)"** (off by default).
- Verbosity: **Debug pane -> Logs -> App logging -> Verbosity** picker.
- Location: `~/Library/Logs/OpenClaw/diagnostics.jsonl`.
- Rotation: rotates at 5 MB; up to 5 backups suffixed `.1`...`.5` (oldest dropped).
- Clear: **Debug pane -> Logs -> App logging -> "Clear"** deletes the active file and all backups.

Treat the file as sensitive; do not share it without review.

## Unified logging private data on macOS

Unified logging redacts most payloads unless a subsystem opts into `privacy -off`. This is controlled by a plist in `/Library/Preferences/Logging/Subsystems/` keyed by subsystem name. Only new log entries pick up the flag, so enable it before reproducing an issue. Background: [macOS logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans).

## Enable for OpenClaw (`ai.openclaw`)

Write the plist to a temp file first, then install it atomically as root:

```bash
cat <<'EOF' >/tmp/ai.openclaw.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/ai.openclaw.plist /Library/Preferences/Logging/Subsystems/ai.openclaw.plist
```

No reboot required; logd picks up the file quickly, but only new log lines include private payloads. View the richer output with `./scripts/clawlog.sh --category WebChat --last 5m` (`--last`/`-l` sets the time range, default `5m`; `--category`/`-c` filters by category).

## Disable after debugging

- Remove the override: `sudo rm /Library/Preferences/Logging/Subsystems/ai.openclaw.plist`.
- Optionally run `sudo log config --reload` to force logd to drop the override immediately.
- This surface can include phone numbers and message bodies; keep the plist in place only while actively needed.

## Related

- [macOS app](/platforms/macos)
- [Gateway logging](/gateway/logging)
