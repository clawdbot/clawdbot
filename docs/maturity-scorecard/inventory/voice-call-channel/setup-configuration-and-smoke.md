---
title: "Voice Call channel - Channel Setup and Operations Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice Call channel - Channel Setup and Operations Maturity Note

## Summary

This note migrates archived maturity evidence for `Voice Call channel` / `Setup, Configuration, and Smoke` into the current process-version-3 scorecard inventory.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Channel Setup and Operations`
- Merged from: `Setup and Operations`, `Webhook Security`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Voice Call Channel: Cli, Gateway Rpc, and Agent Tool
- Voice Call Channel: Setup, Configuration, and Smoke
- Voice Call Channel: Webhook Exposure and Security

## Features

- Voice Call Channel: Cli, Gateway Rpc, and Agent Tool
- Voice Call Channel: Setup, Configuration, and Smoke

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (42%)`

Setup has a real docs path, manifest metadata, Gateway runtime validation, setup status checks, and dry-run/live smoke commands. It stays Experimental because the evidence does not show a repeatable live setup suite across the supported carriers, and archive evidence shows setup remains sensitive to Gateway process config, public webhook exposure, and schema/SecretRef alignment.

## Quality Score

- Score: `Alpha (56%)`

Quality is based on docs, runtime contracts, fail-closed behavior, and open issue/archive state. Test existence and test breadth were not counted in this Quality score.

The implementation has a coherent Gateway-first setup model, explicit provider credential validation, dry-run smoke defaults, and public URL fail-closed behavior. It is not higher because setup spans local service env, plugin install state, Gateway restart state, public webhooks, SecretRefs, and optional tunnels, all of which show up as operator friction in the archives.

## Completeness Score

- Score: `Experimental (42%)`
- Surface instructions: evaluated against `references/completeness/voice-call-channel.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Voice Call Channel, Voice Call Channel.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No live setup matrix was found for Twilio, Telnyx, and Plivo.
- Setup depends on Gateway process env and restart state, which Discord evidence shows can differ from interactive CLI state.
- Manifest/schema, SecretRef, and provider credential paths have enough historical friction that the setup path should remain Experimental.

## Evidence

### Docs

- `docs/plugins/voice-call.md:19-23` states that the plugin runs inside the Gateway process and should be installed/configured on the Gateway machine.
- `docs/plugins/voice-call.md:25-80` documents install, configure, setup, and smoke commands; setup checks plugin enablement, provider credentials, webhook exposure, and audio mode; smoke defaults to dry-run and requires `--yes` for live calls.
- `docs/plugins/voice-call.md:83-99` requires a public webhook URL for Twilio/Telnyx/Plivo and says missing provider credentials skip runtime initialization.
- `docs/cli/voicecall.md:9-14` states the `voicecall` command appears when the plugin is installed/enabled and Gateway commands route to the Gateway runtime with standalone fallback.
- `docs/cli/voicecall.md:47-78` documents setup and smoke behavior, including the public webhook requirement.

### Source

- `extensions/voice-call/openclaw.plugin.json:1-26` defines plugin id `voice-call`, command alias `voicecall`, tool contract `voice_call`, and provider/tunnel env vars.
- `extensions/voice-call/src/config.ts:740-883` resolves env-based provider/tunnel/webhook settings and validates provider credentials plus streaming/realtime constraints.
- `extensions/voice-call/src/runtime.ts:263-528` creates the runtime, validates provider/public URL behavior, starts the webhook server, and cleans up initialization failures.
- `extensions/voice-call/src/cli.ts:285-332` builds setup status for plugin enablement, provider configuration, webhook exposure, and audio mode.
- `extensions/voice-call/src/cli.ts:406-515` registers setup and smoke commands, including dry-run and live call paths.

### Integration tests

- `extensions/voice-call/src/runtime.test.ts:208-260` covers cleanup when runtime initialization fails.
- `extensions/voice-call/src/runtime.test.ts:284-303` verifies full config is passed to webhook server setup.
- `extensions/voice-call/src/runtime.test.ts:305-351` verifies external providers fail closed on local-only webhooks and accept public URLs.

### Unit tests

- `extensions/voice-call/src/config.test.ts:32-279` covers provider credential/env validation and SecretRef handling.
- `extensions/voice-call/src/config.test.ts:399-545` covers defaults, custom realtime stream path, TTS overrides, and realtime settings.
- `extensions/voice-call/src/config-compat.test.ts:11-162` covers legacy config shape migration and doctor warning/change output.

### Gitcrawl queries

- `gitcrawl search issues "voicecall setup smoke webhook" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned no results, so no issue archive evidence was found for those exact setup/smoke terms.
- `gitcrawl search prs "voicecall setup smoke webhook" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned no results, so no PR archive evidence was found for those exact setup/smoke terms.
- `gitcrawl search issues "voice-call" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned broad open voice-call issues including latency (#79521), stale Twilio reaper (#79121), failed/no-stream hold music (#81122), double greeting (#85846), sibling stream path upgrades (#79918), and tool binding (#80840), which keep setup certainty below Beta because the path is still actively changing.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voicecall setup smoke webhook"`: returned `null`, so no Discord archive hits were found for those exact terms.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call twilio telnyx plivo"`: returned user-facing setup guidance for installing `@openclaw/voice-call`, configuring `plugins.entries["voice-call"].config`, choosing Twilio/Telnyx/Plivo, exposing a public webhook, and noting that the plugin runs inside Gateway.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call webhook guard public url"`: returned evidence that the webhook guard landed so external providers fail fast when they would fall back to loopback/private URLs.

### Archived source snapshot

- `gitcrawl doctor --json`: `version=0.2.1`, `api_supported=false`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `github_token_present=false`, `openai_key_present=true`.
- `/Users/kevinlin/.local/bin/discrawl status --json`: `state=current`, `generated_at=2026-05-29T16:49:09Z`, `last_sync_at=2026-05-29T15:59:50Z`, `messages=1487061`, `channels=25819`, `threads=25591`, `embedding_backlog=0`, `share.needs_update=true`.
