---
summary: "macOS app log redaction, opt-in diagnostics files, and native OSLog privacy flags"
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

The file log is a separate, explicit opt-in. Enabling it does not disable the app's interpolation redaction described below. It still includes public and unannotated messages, metadata, and direct diagnostic records, which can contain sensitive data. Enable it only while debugging, turn it off afterward, and review the active file and backups before sharing.

## Export unified logs as JSON

Run `./scripts/clawlog.sh --json` to write recent unified-log events as one JSON array to stdout, or add `--output logs.json` to write the array to a file without printing it. The default output contains the last 50 log records; use `--lines 1` for the most recent record or `--all` for every matching record. `--lines` counts complete records in JSON mode, not physical lines.

JSON export cannot be combined with `--follow` or `--list-categories`. Use those options without `--json`.

## App logger redaction

The macOS app's swift-log bridge renders messages as text before handing them to unified logging or the optional file log. Its interpolation annotations are app-side rules, not native OSLog privacy metadata:

- `privacy: .private` replaces the value with `<private>` before either sink receives it.
- `privacy: .private(mask: .hash)` replaces the value with a keyed hash. Equal values correlate within one app process; hashes change when the app restarts.
- `privacy: .public`, unannotated interpolations, and swift-log metadata are not automatically redacted. Do not assume that a log is safe to share just because it came from unified logging.

This also protects private interpolations in strings that are concatenated before logging. Verbosity changes, file capture, and macOS private-data overrides cannot restore values removed by the app's bridge.

## Unified logging private data on macOS

Some shared components use native OSLog directly rather than the app's swift-log bridge. Native OSLog normally redacts private values; explicitly public values remain visible. For those native events, a subsystem plist in `/Library/Preferences/Logging/Subsystems/` can enable private-data capture. This is not a way to reveal the bridge's `<private>` placeholders or hashes. Background: [macOS logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans).

## Enable for OpenClaw (`ai.openclaw`)

Use this only when you need private values from **native OSLog** events. Check for an existing `ai.openclaw.plist` first and preserve it so you can restore the prior settings afterward. Write the plist to a temp file, then install it atomically as root:

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

Enable the override before reproducing the issue: it affects new native OSLog events, not entries already collected. Inspect the output with `./scripts/clawlog.sh --category WebChat --last 5m` (`--last`/`-l` sets the time range, default `5m`; `--category`/`-c` filters by category).

## Disable after debugging

- If you created the plist for this capture, remove it: `sudo rm /Library/Preferences/Logging/Subsystems/ai.openclaw.plist`. If it existed beforehand, restore the saved version instead.
- The override can expose phone numbers and message bodies in native events. Keep it enabled only while needed; removing it does not erase data already captured.
- Turn off rolling file capture separately if you enabled it. The macOS override does not control that sink.

## Related

- [macOS app](/platforms/macos)
- [Gateway logging](/gateway/logging)
