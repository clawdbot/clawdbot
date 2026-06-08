---
title: "Voice and realtime talk - Agent Consult, Steering, and Talkback Controls Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice and realtime talk - Agent Consult, Steering, and Talkback Controls Maturity Note

## Summary

The agent consult/control surface is a core Talk differentiator: realtime providers call `openclaw_agent_consult`, and users/operators can steer or cancel the embedded agent run. Coverage is beta-level. Quality is beta-level but still exposed to archive-reported latency, tool-policy, and spoken-output divergence problems.

## Category Scope

- `openclaw_agent_consult` tool-call handling.
- Active Talk agent-run status, cancel, steer, and follow-up controls.
- Talkback runtime behavior and assistant speech coordination.
- Forced consult scheduling and control event propagation.

## Features

- Agent consult handoff: Consult handoff behavior between active Talk sessions and agent runs.
- Active Talk agent-run status: Active Talk agent-run status, cancel, steer, and follow-up controls
- Talkback runtime behavior: Talkback runtime behavior and assistant speech coordination
- Forced consult scheduling: Forced consult scheduling and control event propagation

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`

The component has docs for consult and steering, Gateway source, UI adapters, plugin SDK types, relay runtime hooks, and tests across consult/control modules. Coverage is not stable because the real behavior spans LLM calls, speech output, and provider bridge timing.

## Quality Score

- Score: `Beta (72%)`

Quality benefits from explicit active-run resolution, cancellation, steering, follow-up queueing, idempotency, diagnostic activity, and provider-facing control hooks. Quality risk remains where realtime consult is slow, where tools are advertised but unavailable, and where voice output can diverge from Control UI delivery.

Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/voice-and-realtime-talk.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Agent consult handoff, Active Talk agent-run status, Talkback runtime behavior, Forced consult scheduling.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Realtime consult latency and fragility have been called out in archive evidence.
- Tool-policy mismatches can confuse provider instructions.
- Delivery mirror behavior can make Talk speak a different answer than the Control UI shows.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md:23` describes browser realtime consult through `talk.client.toolCall`.
- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md:24` documents `talk.client.steer` and `talk.session.steer`.
- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md:101` documents consult and steering in the browser Talk path.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk-client.ts:160` implements `talk.client.toolCall` and validates `openclaw_agent_consult`.
- `/Users/kevinlin/code/openclaw/src/gateway/talk-agent-consult.ts:14` builds and sends consult chat requests with Talk-specific runtime options.
- `/Users/kevinlin/code/openclaw/src/talk/agent-run-control.ts:58` controls active embedded Talk agent runs for status, cancellation, steering, and follow-up.
- `/Users/kevinlin/code/openclaw/src/talk/agent-consult-runtime.ts:193` starts consult runtime sessions and handles delivery context.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/realtime-voice.ts:1` exports realtime voice provider types, control hooks, consult types, and diagnostics hooks.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/talk-realtime-relay.test.ts`
- `/Users/kevinlin/code/openclaw/ui/src/ui/realtime-talk-consult.test.ts`
- `/Users/kevinlin/code/openclaw/ui/src/ui/realtime-talk-gateway-relay.test.ts`
- `/Users/kevinlin/code/openclaw/ui/src/ui/realtime-talk-webrtc.test.ts`

### Unit tests

- `/Users/kevinlin/code/openclaw/src/talk/agent-consult-runtime.test.ts`
- `/Users/kevinlin/code/openclaw/src/talk/agent-consult-tool.test.ts`
- `/Users/kevinlin/code/openclaw/src/talk/agent-run-control.test.ts`
- `/Users/kevinlin/code/openclaw/src/talk/agent-talkback-runtime.test.ts`
- `/Users/kevinlin/code/openclaw/src/talk/forced-consult-coordinator.test.ts`

### Gitcrawl queries

- `gitcrawl search issues "openclaw_agent_consult realtime voice" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned #85275 for spoken-output mismatch, #86425 for camera frame support, and #80840 for advertised realtime tools without handler binding.
- `gitcrawl search issues "talk.session gateway relay" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned #84664 and #84639, both relevant to richer realtime context and speech injection.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search "openclaw_agent_consult realtime" --limit 5` returned #71849 archive evidence that realtime voice consult can be too slow or fragile for live calls.
- `/Users/kevinlin/.local/bin/discrawl search "gateway relay talk" --limit 5` returned #71262 fixed-on-main evidence for exposing Gateway agent tools through the shared realtime consult tool and a PR #71272 review comment about `toolPolicy: none` instructions.
