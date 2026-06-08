---
title: "Voice and realtime talk Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice and realtime talk Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (73%)`
- Quality: `Alpha (67%)`
- Completeness: `Beta (73%)`
- LTS Features: `0/6`

## Summary

This report promotes the archived `voice-and-realtime-talk` maturity evidence from `/Users/kevinlin/tmp/maturity/voice-and-realtime-talk` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                      | LTS | Coverage      | Quality       | Completeness  | Features to evaluate                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | --- | ------------- | ------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Talk Providers](talk-configuration-catalog-and-provider-selection.md)        | ❌  | `Beta (74%)`  | `Alpha (68%)` | `Beta (74%)`  | OpenAI Realtime voice backend bridge, Google Gemini Live backend bridge, Realtime voice provider SDK contracts, Provider diagnostics, Talk catalog, Talk provider config, Shared native config parsing                                                                                  |
| [Realtime Talk Sessions](gateway-relay-and-realtime-session-runtime.md)       | ❌  | `Beta (72%)`  | `Alpha (68%)` | `Beta (72%)`  | Agent consult handoff, Active Talk agent-run status, Talkback runtime behavior, Forced consult scheduling, Browser Talk start/stop UI, Browser WebRTC sessions, Browser relay mode, Browser tool-call forwarding, Realtime session controls, Gateway relay sessions, Audio-frame limits |
| [Speech and Transcription](speech-transcription-directives-and-talk-speak.md) | ❌  | `Beta (72%)`  | `Alpha (68%)` | `Beta (72%)`  | Voice directives, Talk speech playback, Transcription relay sessions, Realtime transcription providers, Native directive parsing                                                                                                                                                        |
| [Native App Talk](native-app-talk-loops-ios-android-macos.md)                 | ❌  | `Alpha (68%)` | `Alpha (64%)` | `Alpha (68%)` | macOS native Talk mode, iOS Talk mode, Android Talk mode, Shared Talk config                                                                                                                                                                                                            |
| [Voice Wake and Routing](voice-wake-push-to-talk-and-routing.md)              | ❌  | `Beta (74%)`  | `Alpha (66%)` | `Beta (74%)`  | Wake-word settings, Wake routing, macOS Voice Wake runtime, Mobile wake preferences                                                                                                                                                                                                     |
| [Talk Observability](observability-diagnostics-session-health-and-latency.md) | ❌  | `Beta (76%)`  | `Beta (70%)`  | `Beta (76%)`  | Talk event logging, Session-log health, Live smoke output, Prometheus diagnostic counters, Operator visibility into setup                                                                                                                                                               |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching
  taxonomy category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.

## Detailed feature inventory

### 1. Talk Providers

Search anchors: OpenAI Realtime, Google Gemini Live, realtime voice provider, talk.catalog, talk.config.

Category note: [Talk Providers](talk-configuration-catalog-and-provider-selection.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- OpenAI Realtime voice backend bridge: OpenAI Realtime voice backend bridge and browser WebRTC credential path
- Google Gemini Live backend bridge: Google Gemini Live backend bridge and browser token/WebSocket path
- Realtime voice provider SDK contracts: Realtime voice provider SDK contracts, activation metadata, provider registry, and resolver
- Provider diagnostics: Provider diagnostics, reconnect behavior, tool declarations, and bridge session lifecycle
- Talk catalog: Talk catalog discovery for transport, brain, speech, realtime voice, and transcription providers.
- Talk provider config: Talk provider selection, provider-specific realtime settings, and secret exposure rules.
- Shared native config parsing: Shared native config parsing for macOS, iOS, and Android

Primary docs:

- `docs/providers/openai.md`
- `docs/providers/google.md`
- `docs/plugins/sdk-provider-plugins.md`
- `docs/nodes/talk.md`
- `docs/web/control-ui.md`

### 2. Realtime Talk Sessions

Search anchors: Talk agent-run status, talkback, consult handoff, Browser Talk start/stop, OpenAI WebRTC, browser relay mode, talk.session.create, appendAudio, cancelTurn, submitToolResult.

Category note: [Realtime Talk Sessions](gateway-relay-and-realtime-session-runtime.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- Agent consult handoff: Consult handoff behavior between active Talk sessions and agent runs.
- Active Talk agent-run status: Active Talk agent-run status, cancel, steer, and follow-up controls
- Talkback runtime behavior: Talkback runtime behavior and assistant speech coordination
- Forced consult scheduling: Forced consult scheduling and control event propagation
- Browser Talk start/stop UI: Browser Talk start/stop UI and status display
- Browser WebRTC sessions: Browser WebRTC sessions for OpenAI Realtime and Google Live providers.
- Browser relay mode: Browser relay mode for backend-only realtime providers.
- Browser tool-call forwarding: Browser tool-call forwarding, transcript events, and audio playback
- Realtime session controls: Realtime session create, audio append, turn cancellation, steering, tool-result submission, and close controls.
- Gateway relay sessions: Gateway relay sessions for realtime voice and transcription flows.
- Audio-frame limits: Audio-frame limits, session TTL, per-connection/global caps, transcript events, and relay cleanup

Primary docs:

- `docs/nodes/talk.md`
- `docs/web/control-ui.md`

### 3. Speech and Transcription

Search anchors: talk.speak, voice directives, transcription relay sessions.

Category note: [Speech and Transcription](speech-transcription-directives-and-talk-speak.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- Voice directives: Voice directives and directive stripping before TTS playback.
- Talk speech playback: Gateway talk.speak and fallback TTS behavior.
- Transcription relay sessions: Gateway transcription relay sessions, transcript events, and cleanup behavior.
- Realtime transcription providers: Realtime transcription provider selection, diagnostics, and provider-specific bridge behavior.
- Native directive parsing: Native directive parsing and Talk speech locale behavior

Primary docs:

- `docs/nodes/talk.md`
- `docs/providers/openai.md`
- `docs/providers/google.md`

### 4. Native App Talk

Search anchors: macOS native Talk mode, iOS Talk mode, Android Talk mode.

Category note: [Native App Talk](native-app-talk-loops-ios-android-macos.md)

Score decisions:

- Coverage: `Alpha (68%)`
- Quality: `Alpha (64%)`
- Completeness: `Alpha (68%)`
- LTS: ❌

Features:

- macOS native Talk mode: macOS native Talk mode, speech recognition, TTS playback, and push-to-talk handoff
- iOS Talk mode: iOS Talk mode, WebRTC sessions, realtime relay sessions, and wake preferences
- Android Talk mode: Android Talk mode, speech-recognizer mode, realtime relay, mic capture, and debug E2E receiver
- Shared Talk config: Shared Talk config and command parsing

Primary docs:

- `docs/nodes/talk.md`
- `docs/platforms/mac/voicewake.md`

### 5. Voice Wake and Routing

Search anchors: Voice Wake, push-to-talk, wake-word settings.

Category note: [Voice Wake and Routing](voice-wake-push-to-talk-and-routing.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Wake-word settings: Gateway-owned wake-word settings and routing preferences.
- Wake routing: Default, last-focused app, local app, and specific-node routing methods.
- macOS Voice Wake runtime: macOS Voice Wake runtime, push-to-talk hotkey, overlay adoption, pause/resume behavior, and forwarding
- Mobile wake preferences: iOS and Android wake preferences and command extraction.

Primary docs:

- `docs/nodes/voicewake.md`
- `docs/platforms/mac/voicewake.md`
- `docs/platforms/mac/voice-overlay.md`

### 6. Talk Observability

Search anchors: Talk event logging, session-log health, latency visibility.

Category note: [Talk Observability](observability-diagnostics-session-health-and-latency.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- Talk event logging: Talk event logging and diagnostics event mapping
- Session-log health: Session-log health, transcript records, bridge events, and echo/output suppression timing
- Live smoke output: Live smoke output and provider event inspection
- Prometheus diagnostic counters: Prometheus diagnostic counters for Talk events
- Operator visibility into setup: Operator visibility into setup, latency, and failure modes

Primary docs:

- `docs/web/control-ui.md`
- `docs/platforms/mac/voice-overlay.md`
- `docs/nodes/talk.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/voice-and-realtime-talk/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/voice-and-realtime-talk`.
