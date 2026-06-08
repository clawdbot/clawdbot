---
title: "Voice Call channel Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice Call channel Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Experimental (49%)`
- Quality: `Alpha (58%)`
- Completeness: `Experimental (49%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `voice-call-channel` maturity evidence from `/Users/kevinlin/tmp/maturity/voice-call-channel` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                       | LTS | Coverage             | Quality       | Completeness         | Features to evaluate                   |
| ------------------------------------------------------------------------------ | --- | -------------------- | ------------- | -------------------- | -------------------------------------- |
| [Channel Setup and Operations](setup-configuration-and-smoke.md)               | ❌  | `Experimental (42%)` | `Alpha (56%)` | `Experimental (42%)` | Voice Call Channel, Voice Call Channel |
| [Access and Identity](webhook-exposure-and-security.md)                        | ❌  | `Alpha (60%)`        | `Alpha (62%)` | `Alpha (60%)`        | Voice Call Channel                     |
| [Conversation Routing and Delivery](inbound-routing-sessions-and-lifecycle.md) | ❌  | `Alpha (52%)`        | `Alpha (58%)` | `Alpha (52%)`        | Voice Call Channel                     |
| [Media and Rich Content](provider-transports-and-call-control.md)              | ❌  | `Experimental (48%)` | `Alpha (57%)` | `Experimental (48%)` | Voice Call Channel, Voice Call Channel |
| [Realtime Voice and Calls](realtime-voice-and-agent-consult.md)                | ❌  | `Experimental (44%)` | `Alpha (55%)` | `Experimental (44%)` | Voice Call Channel, Voice Call Channel |

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

### 1. Channel Setup and Operations

Search anchors: voice call channel voice call channel: cli, gateway rpc, and agent tool, voice call channel: cli, gateway rpc, and agent tool, voice call channel voice call channel: setup, configuration, and smoke, voice call channel: setup, configuration, and smoke.

Category note: [Channel Setup and Operations](setup-configuration-and-smoke.md)

Score decisions:

- Coverage: `Experimental (42%)`
- Quality: `Alpha (56%)`
- Completeness: `Experimental (42%)`
- LTS: ❌

Features:

- Voice Call Channel: Cli, Gateway Rpc, and Agent Tool
- Voice Call Channel: Setup, Configuration, and Smoke

Primary docs:

- `docs/cli/voicecall.md`
- `docs/plugins/voice-call.md`
- `docs/gateway/protocol.md`

### 2. Access and Identity

Search anchors: voice call channel voice call channel: webhook exposure and security, voice call channel: webhook exposure and security.

Category note: [Access and Identity](webhook-exposure-and-security.md)

Score decisions:

- Coverage: `Alpha (60%)`
- Quality: `Alpha (62%)`
- Completeness: `Alpha (60%)`
- LTS: ❌

Features:

- Voice Call Channel: Webhook Exposure and Security

Primary docs:

- `docs/plugins/voice-call.md`
- `docs/cli/voicecall.md`

### 3. Conversation Routing and Delivery

Search anchors: voice call channel voice call channel: inbound routing, sessions, and lifecycle, voice call channel: inbound routing, sessions, and lifecycle.

Category note: [Conversation Routing and Delivery](inbound-routing-sessions-and-lifecycle.md)

Score decisions:

- Coverage: `Alpha (52%)`
- Quality: `Alpha (58%)`
- Completeness: `Alpha (52%)`
- LTS: ❌

Features:

- Voice Call Channel: Inbound Routing, Sessions, and Lifecycle

Primary docs:

- `docs/plugins/voice-call.md`

### 4. Media and Rich Content

Search anchors: voice call channel voice call channel: provider transports and call control, voice call channel: provider transports and call control, voice call channel voice call channel: telephony tts, playback, dtmf, and audio, voice call channel: telephony tts, playback, dtmf, and audio.

Category note: [Media and Rich Content](provider-transports-and-call-control.md)

Score decisions:

- Coverage: `Experimental (48%)`
- Quality: `Alpha (57%)`
- Completeness: `Experimental (48%)`
- LTS: ❌

Features:

- Voice Call Channel: Provider Transports and Call Control
- Voice Call Channel: Telephony Tts, Playback, Dtmf, and Audio

Primary docs:

- `docs/plugins/voice-call.md`
- `docs/plugins/plugin-inventory.md`

### 5. Realtime Voice and Calls

Search anchors: voice call channel voice call channel: realtime voice and agent consult, voice call channel: realtime voice and agent consult, voice call channel voice call channel: streaming transcription and auto-response, voice call channel: streaming transcription and auto-response.

Category note: [Realtime Voice and Calls](realtime-voice-and-agent-consult.md)

Score decisions:

- Coverage: `Experimental (44%)`
- Quality: `Alpha (55%)`
- Completeness: `Experimental (44%)`
- LTS: ❌

Features:

- Voice Call Channel: Realtime Voice and Agent Consult
- Voice Call Channel: Streaming Transcription and Auto-response

Primary docs:

- `docs/plugins/voice-call.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/voice-call-channel/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/voice-call-channel`.
