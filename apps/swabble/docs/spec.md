# swabble — macOS 26 speech hook daemon (Swift 6.2)

Goal: brabble-style always-on voice hook for macOS 26 using Apple Speech.framework (SpeechAnalyzer + SpeechTranscriber) instead of whisper.cpp. Local-only, wake word gated, dispatches a shell hook with the transcript. Shared wake-gate utilities live in `SwabbleKit` for reuse by other apps (iOS/macOS).

## Requirements
- macOS 26+, Swift 6.2, Speech.framework with on-device assets.
- Local only; no network calls during transcription.
- Wake word gating (default "clawd" plus aliases) with bypass flag `--no-wake`.
- `SwabbleKit` target (multi-platform) providing wake-word gating helpers that can use speech segment timing to require a post-trigger gap.
- Hook execution with cooldown, min_chars, timeout, prefix, env vars.
- Simple config at `~/.config/swabble/config.json` (JSON, Codable) — no TOML.
- CLI implemented with Commander (SwiftPM package `steipete/Commander`); core types are available via the SwiftPM library product `Swabble` for embedding.
- Foreground `serve`; later launchd helper for start/stop/restart.
- File transcription command emitting txt or srt.
- Basic status/health surfaces and mic selection stubs.

## Architecture
- **CLI layer (Commander)**: Root command `swabble` with subcommands `serve`, `transcribe`, `test-hook`, `mic list|set`, `doctor`, `health`, `tail-log`. Runtime flags from Commander (`-v/--verbose`, `--json-output`, `--log-level`). Custom `--config` path applies everywhere.
- **Config**: `SwabbleConfig` Codable. Fields: audio device name/index, wake (enabled/word/aliases/sensitivity placeholder), hook (command/args/prefix/cooldown/min_chars/timeout/env), logging (level, format), transcripts (enabled, max kept), speech (locale, enableEtiquetteReplacements flag). Stored JSON; default written by `setup`.
- **Audio + Speech pipeline**: `SpeechPipeline` wraps `AVAudioEngine` input → `SpeechAnalyzer` with `SpeechTranscriber` module. Emits partial/final transcripts via async stream. Requests `.audioTimeRange` when transcripts enabled. Handles Speech permission and asset download prompts ahead of capture.
- **Wake gate**: CLI currently uses text-only keyword match; shared `SwabbleKit` gate can enforce a minimum pause between the wake word and the next token when speech segments are available. `--no-wake` disables gating.
- **Hook executor**: async `HookExecutor` spawns `Process` with configured args, prefix substitution `${hostname}`. Enforces cooldown + timeout; injects env `SWABBLE_TEXT`, `SWABBLE_PREFIX` plus user env map.
- **Transcripts store**: in-memory ring buffer; optional persisted JSON lines under `~/Library/Application Support/swabble/transcripts.log`.
- **Logging**: simple structured logger to stderr; respects log level.

## Out of scope (initial cut)
- Model management (Speech handles assets).
- Launchd helper (planned follow-up).
- Advanced wake-word detector (segment-aware gate now lives in `SwabbleKit`; CLI still text-only until segment timing is plumbed through).

## Open decisions
- Whether to expose a UNIX control socket for `status`/`health` (currently planned as stdin/out direct calls).
- Hook redaction (PII) parity with brabble — placeholder boolean, no implementation yet.
