# 🎙️ swabble — Speech.framework wake-word hook daemon (macOS 26)

swabble is a Swift 6.2 wake-word hook daemon. The CLI targets macOS 26 (SpeechAnalyzer + SpeechTranscriber). The shared `SwabbleKit` target is multi-platform and exposes wake-word gating utilities for iOS/macOS apps.

- **Local-only**: Speech.framework on-device models; zero network usage.
- **Wake word**: Default `clawd` (aliases `claude`), optional `--no-wake` bypass.
- **SwabbleKit**: Shared wake gate utilities (gap-based gating when you provide speech segments).
- **Hooks**: Run any command with prefix/env, cooldown, min_chars, timeout.
- **Services**: launchd helper stubs for start/stop/install.
- **File transcribe**: TXT or SRT with time ranges (using AttributedString splits).

## Quick start
```bash
# Install deps
brew install swiftformat swiftlint

# Build
swift build

# Write default config (~/.config/swabble/config.json)
swift run swabble setup

# Run foreground daemon
swift run swabble serve

# Test your hook
swift run swabble test-hook "hello world"

# Transcribe a file to SRT
swift run swabble transcribe /path/to/audio.m4a --format srt --output out.srt
```

## Use as a library
Add swabble as a SwiftPM dependency and import the `Swabble` or `SwabbleKit` product:

```swift
// Package.swift
dependencies: [
    .package(url: "https://github.com/steipete/swabble.git", branch: "main"),
],
targets: [
    .target(name: "MyApp", dependencies: [
        .product(name: "Swabble", package: "swabble"),     // Speech pipeline (macOS 26+ / iOS 26+)
        .product(name: "SwabbleKit", package: "swabble"),  // Wake-word gate utilities (iOS 17+ / macOS 15+)
    ]),
]
```

## CLI
- `serve` — foreground loop (mic → wake → hook)
- `transcribe <file>` — offline transcription (txt|srt)
- `test-hook "text"` — invoke configured hook
- `mic list|set <index>` — enumerate/select input device
- `setup` — write default config JSON
- `doctor` — check Speech auth & device availability
- `health` — prints `ok`
- `tail-log` — last 10 transcripts
- `status` — show wake state + recent transcripts
- `service install|uninstall|status` — user launchd plist (stub: prints launchctl commands)
- `start|stop|restart` — placeholders until full launchd wiring

All commands accept Commander runtime flags (`-v/--verbose`, `--json-output`, `--log-level`), plus `--config` where applicable.

## Config
`~/.config/swabble/config.json` (auto-created by `setup`):
```json
{
  "audio": {"deviceName": "", "deviceIndex": -1, "sampleRate": 16000, "channels": 1},
  "wake": {"enabled": true, "word": "clawd", "aliases": ["claude"]},
  "hook": {
    "command": "",
    "args": [],
    "prefix": "Voice swabble from ${hostname}: ",
    "cooldownSeconds": 1,
    "minCharacters": 24,
    "timeoutSeconds": 5,
    "env": {}
  },
  "logging": {"level": "info", "format": "text"},
  "transcripts": {"enabled": true, "maxEntries": 50},
  "speech": {"localeIdentifier": "en_US", "etiquetteReplacements": false}
}
```

- Config path override: `--config /path/to/config.json` on relevant commands.
- Transcripts persist to `~/Library/Application Support/swabble/transcripts.log`.

## Hook protocol
When a wake-gated transcript passes min_chars & cooldown, swabble runs:
```
<command> <args...> "<prefix><text>"
```
Environment variables:
- `SWABBLE_TEXT` — stripped transcript (wake word removed)
- `SWABBLE_PREFIX` — rendered prefix (hostname substituted)
- plus any `hook.env` key/values

## Speech pipeline
- `AVAudioEngine` tap → `BufferConverter` → `AnalyzerInput` → `SpeechAnalyzer` with a `SpeechTranscriber` module.
- Requests volatile + final results; the CLI uses text-only wake gating today.
- Authorization requested at first start; requires macOS 26 + new Speech.framework APIs.

## Development
- Format: `./scripts/format.sh` (uses local `.swiftformat`)
- Lint: `./scripts/lint.sh` (uses local `.swiftlint.yml`)
- Tests: `swift test` (uses swift-testing package)

## Roadmap
- launchd control (load/bootout, PID + status socket)
- JSON logging + PII redaction toggle
- Stronger wake-word detection and control socket status/health
