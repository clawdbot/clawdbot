# Proposal: managed whisper.cpp plugin for OpenClaw

Status: proposal, not yet scheduled.
Tracking: pair with the `extensions/openai-compatible-stt` universal WebSocket
STT plugin introduced in `feat/local-dictation-settings`. That plugin covers
the user-managed endpoint case; this proposal covers the bundled,
plugin-managed lifecycle case.

## Problem

`docs/nodes/audio.md` documents the gap explicitly:

> OpenClaw does not currently manage a resident whisper.cpp server because the
> standard Homebrew `whisper-cpp` package disables that server, while the
> upstream example has no configured bounded admission queue. A plugin-owned
> resident lifecycle needs a maintained packaged worker with
> health/startup, model residency, bounded queueing, cancellation/timeout,
> loopback-only no-auth operation, and no cloud fallback before it can be
> enabled safely.

In other words, the browser-composer microphone button already streams audio
to the configured realtime transcription provider via
`talk.transcription`. But there is no first-party OpenClaw-managed worker
that hosts the underlying model. Users who want local dictation today must
either:

- Run `faster-whisper-server` / `whisper.cpp --server` / `vLLM` themselves and
  point `extensions/openai-compatible-stt` at it.
- Install a third-party OpenClaw plugin (none maintained upstream).

## Goal

Add a bundled OpenClaw extension that owns the full lifecycle of a
resident whisper.cpp worker. Operator enables the plugin, picks a model,
and OpenClaw runs, supervises, and exposes the worker to the composer
microphone ÔÇö no separate process management, no model downloads outside the
plugin's own sandbox.

## Required capabilities

Taken straight from `docs/nodes/audio.md` plus the existing
`openai-compatible-stt` plugin's wire protocol:

- **Health/startup**: plugin starts the worker on activation, reports
  readiness through `talk.catalog.transcription`, and emits a clear
  diagnostic when startup fails (model missing, GPU unavailable,
  binary-not-installed).
- **Model residency**: model files live under the plugin's state
  directory (`state/plugins/whisper-local/`). Downloads happen lazily on
  first use; the catalog shows which models are downloaded and which
  require a fetch.
- **Bounded queueing**: the worker exposes the same
  `openai-compatible-stt` wire protocol (raw PCM in, JSON transcripts out).
  OpenClaw's existing `createRealtimeTranscriptionWebSocketSession` SDK
  helper handles per-session back-pressure and reconnect; the plugin just
  needs to forward bytes.
- **Cancellation/timeout**: the worker's session ends when the composer
  stops dictating. The plugin must terminate any inflight GPU work within
  the documented 5 s close window.
- **Loopback-only no-auth operation**: the worker binds `127.0.0.1` only
  and uses no auth header. OpenClaw enforces loopback via the standard
  SSRF policy.
- **No cloud fallback**: if the local worker is unreachable, the
  transcription slot reports `notReady`, the composer fallback path stays
  inactive, and `doctor --lint` flags the misconfiguration.

## Wire protocol

Inherit `extensions/openai-compatible-stt` verbatim. That plugin already
documents:

- Client ÔåÆ server: binary `pcm_s16le` mono frames at 16 kHz.
- Server ÔåÆ client: JSON `{type, text?, message?}` events with the
  `partial` / `final` / `speech_start` / `error` shape.

The new plugin is a thinner shell ÔÇö instead of accepting an arbitrary
endpoint URL, it owns the worker process and points the
`openai-compatible-stt` transport at `ws://127.0.0.1:<allocated-port>`.

## Configuration sketch

```json5
{
  plugins: {
    entries: {
      "whisper-local": {
        enabled: true,
        config: {
          // Default model + auto-download. Override to point at a pre-existing
          // ggml file or a slower/bigger model.
          model: "small.en",
          // Loopback bind; default 127.0.0.1.
          bind: "127.0.0.1",
          // Idle unload window. Worker exits after this many idle seconds
          // and is respawned on the next dictation session.
          idleUnloadSeconds: 120,
        },
      },
    },
  },
}
```

`talk.transcription` then references the bundled provider:

```json5
{
  talk: {
    transcription: {
      provider: "whisper-local",
    },
  },
}
```

## Out of scope (for this proposal)

- TTS / voice cloning (separate proposal; the user explicitly limited the
  scope to dictation).
- macOS / iOS native Speech.framework integration (already covered by the
  existing Swabble bridge; no change proposed here).
- Whisper model fine-tuning or training (out of scope for a worker
  plugin).

## Success criteria

1. `pnpm openclaw plugins install bundled:whisper-local` works on
   Windows, macOS, and Linux without operator hand-holding.
2. Operator picks "Whisper (local)" in Talk ÔåÆ Transcription ÔåÆ Provider,
   the worker starts, the status row turns green within 60 seconds on a
   recent laptop, and clicking the chat-composer microphone button starts
   dictation that types into the composer within ~1.5 seconds of utterance.
3. The worker unloads after `idleUnloadSeconds` of inactivity and is
   respawned on the next session. GPU memory for the worker drops to
   baseline between sessions.
4. `doctor --lint` flags the plugin with a clear remediation hint when
   the worker binary is missing or the model can't be fetched.
