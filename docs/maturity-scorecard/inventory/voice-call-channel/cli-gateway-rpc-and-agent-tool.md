---
title: "Voice Call channel - CLI, Gateway RPC, and Agent Tool Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice Call channel - CLI, Gateway RPC, and Agent Tool Maturity Note

## Summary

This note migrates archived maturity evidence for `Voice Call channel` / `CLI, Gateway RPC, and Agent Tool` into the current process-version-3 scorecard inventory.

## Category Scope

This category evaluates the Voice Call channel capability area represented by these taxonomy features:

- Voice Call Channel: Cli, Gateway Rpc, and Agent Tool

## Features

- Voice Call Channel: Cli, Gateway Rpc, and Agent Tool

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (45%)`

The command/RPC/tool surface exists and is documented: `voicecall` CLI subcommands, Gateway runtime delegation, `voice_call` tool actions, Gateway RPC methods, logs, latency, and expose helpers. It remains Experimental because the evidence does not include a stable end-to-end operator matrix and Discord archive evidence shows runtime-singleton/RPC behavior can fail in deployed Gateway setups.

## Quality Score

- Score: `Alpha (56%)`

Quality is based on API shape, Gateway delegation design, fallback semantics, observability hooks, and active operator archive state. Test existence and test breadth were not counted in this Quality score.

The CLI design is practical: Gateway-first delegation avoids local runtime duplication when working correctly, smoke defaults are cautious, and status/tail/latency commands expose operational state. Quality is limited by the documented requirement that the command only exists when installed/enabled and by an operator report where invoking `voice_call` could initialize a second webhook runtime and hit `EADDRINUSE`.

## Completeness Score

- Score: `Experimental (45%)`
- Surface instructions: evaluated against `references/completeness/voice-call-channel.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Voice Call Channel.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Runtime singleton behavior for agent-tool invocation needs stronger proof.
- Gateway restart/RPC registration behavior has operator uncertainty in Discord archive evidence.
- No end-to-end CLI/Gateway/tool scenario matrix was found for install, setup, call, speak, DTMF, end, status, logs, latency, and expose commands.

## Evidence

### Docs

- `docs/cli/voicecall.md:9-14` documents plugin command availability, Gateway delegation, and standalone fallback.
- `docs/cli/voicecall.md:17-45` documents voicecall subcommands.
- `docs/cli/voicecall.md:47-155` documents setup, smoke, and call lifecycle flags.
- `docs/cli/voicecall.md:157-177` documents logs and latency metrics.
- `docs/cli/voicecall.md:178-199` documents expose/Tailscale serve/funnel helpers.
- `docs/plugins/voice-call.md:725-748` documents CLI commands, Gateway delegation when running, and latency from `calls.jsonl`.
- `docs/plugins/voice-call.md:750-763` documents `voice_call` agent tool actions.
- `docs/plugins/voice-call.md:765-778` documents Gateway RPC methods.
- `skills/voice-call/SKILL.md:15-44` documents the voice-call skill flow, plugin enablement requirement, CLI, tool actions, and config notes.

### Source

- `extensions/voice-call/openclaw.plugin.json:1-12` declares the plugin id, command alias, and `voice_call` tool contract.
- `extensions/voice-call/src/cli.ts:406-515` registers setup/smoke command behavior.
- `extensions/voice-call/src/cli.ts:520-867` registers call, start, continue, speak, DTMF, end, status, tail, latency, expose commands, and Gateway fallback behavior.
- `extensions/voice-call/src/runtime.ts:263-528` creates the runtime used by CLI/Gateway/tool paths.
- `docs/gateway/protocol.md:390` includes `talk.event` coverage for telephony observability.

### Integration tests

- `extensions/voice-call/src/runtime.test.ts:208-260` covers runtime cleanup on initialization failure, relevant to duplicate/local runtime risks.
- `extensions/voice-call/src/runtime.test.ts:284-303` verifies runtime config forwarding to webhook server setup.
- `extensions/voice-call/src/runtime.test.ts:380-465` covers realtime consult tool metadata and spawned-by behavior.

### Unit tests

- `extensions/voice-call/src/config.test.ts:32-545` covers config validation used by CLI/Gateway startup paths.
- `extensions/voice-call/src/manager.notify.test.ts:137-370` covers initial call notification behavior used by tool/CLI initiated calls.
- `extensions/voice-call/src/manager.closed-loop.test.ts:35-245` covers continue/turn behavior used by CLI/tool lifecycle paths.

### Gitcrawl queries

- `gitcrawl search issues "voice_call agent tool voicecall status" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned no results for those exact terms.
- `gitcrawl search issues "voice-call" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #80840 for realtime.tools entries advertised to the model without a handler bind path, plus #77753 for multi-agent call routing and #83967 for canonical session-key follow-up.
- `gitcrawl search prs "voice-call" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #80845 for asynchronous consult result delivery, #77763 for routing calls to the calling agent, and #83942 for private outbound objectives.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice_call agent tool voicecall status"`: returned an operator report where invoking the `voice_call` tool produced `EADDRINUSE` on the webhook port, suggesting a second runtime was initialized instead of sharing the Gateway singleton; the same thread asked whether plugin-registered RPC methods should survive Gateway restart.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call twilio telnyx plivo"`: returned user-facing guidance that the `openclaw voicecall call ...` command is real only when the plugin is installed and enabled.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "google meet twilio voice-call"`: returned live usage notes that `voice_call.initiate_call` was used for a fresh audible Twilio test while Google Meet transport state was debugged separately.

### Archived source snapshot

- `gitcrawl doctor --json`: `version=0.2.1`, `api_supported=false`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `github_token_present=false`, `openai_key_present=true`.
- `/Users/kevinlin/.local/bin/discrawl status --json`: `state=current`, `generated_at=2026-05-29T16:49:09Z`, `last_sync_at=2026-05-29T15:59:50Z`, `messages=1487061`, `channels=25819`, `threads=25591`, `embedding_backlog=0`, `share.needs_update=true`.
