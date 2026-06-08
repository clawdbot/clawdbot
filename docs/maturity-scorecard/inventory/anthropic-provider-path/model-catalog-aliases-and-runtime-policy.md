---
title: "Anthropic provider path - Model and Runtime Selection Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Anthropic provider path - Model and Runtime Selection Maturity Note

## Summary

Anthropic model catalog coverage is Stable. The bundled manifest publishes
direct Anthropic and Claude CLI model rows, source backfills current Claude 4.x
variants, normalizes image and 1M context metadata, and maps selected Claude CLI
auth to model-scoped runtime policy. Quality is Beta because users still hit
model allowlist/catalog confusion, and current Claude model naming/metadata
requires frequent forward-compatibility maintenance.

## Category Scope

Included in this category:

- Bundled Claude catalog: Covers Bundled Claude catalog across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Canonical anthropic refs: Covers Canonical anthropic refs across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Claude CLI compatibility: Covers Claude CLI compatibility across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Model picker availability: Covers Model picker availability across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Capability metadata: Covers Capability metadata across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Runtime selection: Covers Runtime selection across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- Session continuity: Covers Session continuity across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- MCP/tool bridge: Covers MCP/tool bridge across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- Permission-mode mapping: Covers Permission-mode mapping across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- Fallback prelude: Covers Fallback prelude across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.

## Features

- Bundled Claude catalog: Covers Bundled Claude catalog across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Canonical anthropic refs: Covers Canonical anthropic refs across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Claude CLI compatibility: Covers Claude CLI compatibility across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Model picker availability: Covers Model picker availability across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Capability metadata: Covers Capability metadata across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Runtime selection: Covers Runtime selection across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- Session continuity: Covers Session continuity across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- MCP/tool bridge: Covers MCP/tool bridge across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- Permission-mode mapping: Covers Permission-mode mapping across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- Fallback prelude: Covers Fallback prelude across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: The bundled manifest includes direct Anthropic and Claude CLI models; docs describe canonical refs and runtime policy; source has forward-compatible model resolution, 1M context normalization, image-capability normalization, and alias migration; tests pin key model metadata behavior.
- Negative signals: The catalog remains static/discovery-light for direct Anthropic and relies on source-maintained forward-compatibility for new Claude ids.
- Integration gaps: Release proof for fresh upstream catalog drift is weaker than the source/unit-test proof.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: PR #75157 addresses catalog display names for agent models; PR #72404 defaults explicit-only vision-capable models to image-capable; PR #80394 adds per-agent model allowlists; PR #67731 pins Opus 4.7 variant resolution and thinking-default regression coverage.
- Discrawl reports: Discord archive includes `claude-cli models not in catalog` and "only Sonnet available" support threads tied to allowlist/catalog configuration and cooldown confusion.
- Good qualities: Canonical refs, alias handling, dynamic model fallback, 1M context metadata, image input normalization, and selected Claude CLI runtime backfill are centralized in the bundled provider.
- Bad qualities: Operators can still confuse auth/profile state, configured model allowlists, provider catalog rows, and runtime selection when a desired Claude model does not appear or is unavailable.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/anthropic-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Bundled Claude catalog, Canonical anthropic refs, Claude CLI compatibility, Model picker availability, Capability metadata, Runtime selection, Session continuity, MCP/tool bridge, Permission-mode mapping, Fallback prelude.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- New Claude model ids and dated variants require ongoing forward-compatibility
  upkeep.
- Docs and config guidance have moved from `claude-cli/*` refs toward canonical
  `anthropic/*` refs plus runtime policy, while legacy configs still exist.
- Model availability UX can still make catalog, allowlist, cooldown, and
  credential problems look similar.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/anthropic.md` documents `anthropic/*` refs, Claude CLI runtime override, Claude 4.6 thinking defaults, prompt caching, media support, and 1M context behavior.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-agents.md` documents runtime-policy precedence and recommends canonical `anthropic/claude-opus-4-7` plus `agentRuntime.id: "claude-cli"`.
- `/Users/kevinlin/code/openclaw/docs/concepts/models.md` documents provider/model ref selection and fallback behavior used by Anthropic rows.

### Source

- `/Users/kevinlin/code/openclaw/extensions/anthropic/openclaw.plugin.json` publishes static model catalog rows for `claude-cli` and `anthropic`, including Opus 4.7, Sonnet 4.6, Opus 4.6, reasoning flags, image input metadata, context windows, max tokens, provider endpoints, alias normalization, and provider request family.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/register.runtime.ts` resolves modern Claude model ids, applies GA 1M context windows, normalizes image media input, publishes Claude CLI catalog entries, and exposes thinking profiles.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/claude-model-refs.ts` canonicalizes Claude family aliases, upgrades old Claude 3/4 refs, and maps legacy `claude-cli/*` refs back to canonical Anthropic refs.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/config-defaults.ts` collects Claude CLI runtime refs and backfills `agentRuntime.id: "claude-cli"` when Claude CLI auth or model selection is active.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` covers provider catalog rows and model list behavior.
- `/Users/kevinlin/code/openclaw/test/scripts/package-acceptance-workflow.test.ts` verifies live Anthropic model profile inputs such as `OPENCLAW_LIVE_GATEWAY_MODELS=anthropic/claude-opus-4-7` and Sonnet/Haiku model lists.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/anthropic/index.test.ts` covers model API defaulting, Claude CLI allowlist backfill, shorthand refs, future Anthropic refs, Opus 4.7 resolution from templates, image media metadata, 1M context normalization, and synthetic auth.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/provider-policy-api.test.ts` covers public provider policy normalization and thinking profile exposure.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/cli-migration.test.ts` covers migration behavior from Claude CLI auth.
- `/Users/kevinlin/code/openclaw/src/agents/model-catalog-lookup.ts` and adjacent tests cover model catalog lookup used by agent runtime selection.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "Anthropic model catalog claude opus sonnet haiku models list"`

Results:

- Returned no direct results for that exact issue query.

Query: `gitcrawl --json search prs -R openclaw/openclaw "Anthropic model catalog Claude Opus 4.7 Sonnet 4.6"`

Results:

- #75157 `fix(ui): use catalog display names for agent models`.
- #72404 `fix(models): default input=[text,image] for vision-capable explicit-only models`.
- #80394 `feat(agents): per-agent model allowlist (with fallback to global)`.

Query: `gitcrawl --json search prs -R openclaw/openclaw "Anthropic thinking"`

Results:

- #67731 `test(anthropic): pin Opus 4.7 variant resolution + thinking-default regression coverage`.
- #70584 `fix: clamp effort=low/minimal to medium for claude-opus-4.7`.

### Discrawl queries

Query: `discrawl search --limit 10 "Anthropic model catalog claude opus sonnet OpenClaw"`

Results:

- Returned support threads for `claude-cli models not in catalog`, configuring Opus/Sonnet model allowlists, and users mistaking rate-limit cooldown for catalog changes.

Query: `discrawl search --limit 10 "Claude CLI OpenClaw auth login claude-cli"`

Results:

- Returned implemented Claude CLI delegation notes and user support threads where model/runtime policy differed between session paths.
