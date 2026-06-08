---
title: "Session, memory, and context engine - Core Prompts and Context Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Session, memory, and context engine - Core Prompts and Context Maturity Note

## Summary

Instruction and context visibility behavior is documented across context docs,
agent docs, channel docs, and transcript hygiene. Source has explicit visibility
filters, bootstrap prompt helpers, bundled skill context, and user-facing
sanitizers for leaked runtime context. Coverage is thinner than core session
storage because much of the behavior is exercised through unit tests and channel
tests rather than full cross-client scenarios.

## Category Scope

This category covers `AGENTS.md`, `USER.md`, `IDENTITY.md`, `SOUL.md`, project
context injection, bootstrap truncation, untrusted supplemental context, context
visibility config, and runtime-context leakage prevention.

## Features

- Instruction Profile: Covers Instruction Profile across `AGENTS.md`, `USER.md`, `IDENTITY.md`, `SOUL.md`, project context injection, bootstrap truncation, untrusted supplemental context, context visibility config, and runtime-context leakage prevention.
- Context Visibility: Covers Context Visibility across `AGENTS.md`, `USER.md`, `IDENTITY.md`, `SOUL.md`, project context injection, bootstrap truncation, untrusted supplemental context, context visibility config, and runtime-context leakage prevention.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (68%)`
- Positive signals: docs explain injected files and visibility; source filters supplemental context and strips runtime-context leakage; tests cover visibility modes and sanitizer behavior.
- Negative signals: fewer full session-flow tests prove profile-file injection, truncation, channel supplemental context, and history redaction together.
- Integration gaps: add a cross-channel scenario that injects profile files, quoted context, thread metadata, and runtime-generated context, then checks model prompt, transcript, WebChat history, and channel reply output.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: exact visibility query returned no results; a broader bootstrap query returned open `#63216` about reset retry loops reinjecting bootstrap context.
- Discrawl reports: exact visibility queries returned no rows.
- Good qualities: docs clearly distinguish memory from context, injected files from tool schemas, and runtime context from visible transcript content.
- Bad qualities: bootstrap truncation and channel supplemental context remain subtle enough to cause operator confusion.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Alpha (68%)`
- Surface instructions: evaluated against `references/completeness/session-memory-and-context-engine.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Instruction Profile, Context Visibility.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Operators still need a clearer way to prove which profile/context files reached a specific run across all clients.
- Supplemental context boundaries are explicit in docs, but not a full redaction boundary for every channel.

## Evidence

### Docs

- `docs/concepts/context.md:100` describes system prompt construction; `docs/concepts/context.md:113` lists injected workspace files; `docs/concepts/context.md:125` documents bootstrap truncation caps.
- `docs/reference/transcript-hygiene.md:32` states runtime/system context is not user transcript.
- `docs/channels/discord.md:285` explains `MEMORY.md`, `AGENTS.md`, and `USER.md` behavior for guild channels; `docs/channels/discord.md:756` marks channel topics as untrusted context.

### Source

- `src/security/context-visibility.ts:16` evaluates supplemental context visibility.
- `src/config/context-visibility.ts:25` resolves per-channel context visibility mode.
- `src/agents/bootstrap-prompt.ts:1` builds full bootstrap guidance and `src/agents/bootstrap-prompt.ts:15` builds limited guidance.
- `src/agents/embedded-agent-helpers/sanitize-user-facing-text.ts:403` sanitizes user-facing text and strips internal runtime context.

### Integration tests

- `src/gateway/openai-http.test.ts:130` verifies history/current context routing for OpenAI-compatible requests.
- `src/agents/embedded-agent-runner/run/attempt.spawn-workspace.context-injection.test.ts` covers spawn workspace context injection.
- `src/gateway/sessions-history-http.test.ts:512` sanitizes phased assistant history entries before returning them.

### Unit tests

- `src/security/context-visibility.test.ts:37` keeps all context in all mode and `src/security/context-visibility.test.ts:47` enforces allowlist mode.
- `src/config/context-visibility.test.ts:33` tests account/channel/default fallback.
- `src/agents/embedded-agent-helpers.sanitizeuserfacingtext.test.ts:552` strips copied runtime context prefaces.

### Gitcrawl queries

Query:

`gitcrawl search issues "AGENTS.md USER.md context visibility transcript hygiene" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned `[]`.

Query:

`gitcrawl search issues "context visibility AGENTS.md bootstrapMaxChars USER.md" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned open `#63216 Repeated hard resets on same session key despite high reserveTokensFloor; retry loop re-injects bootstrap context`.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "AGENTS.md USER.md context visibility transcript hygiene"`

Results:

- Returned no matching rows.

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "context visibility AGENTS.md bootstrapMaxChars USER.md"`

Results:

- Returned no matching rows.
