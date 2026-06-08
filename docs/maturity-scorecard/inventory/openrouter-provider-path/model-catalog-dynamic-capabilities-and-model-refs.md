---
title: "OpenRouter provider path - Model Catalog and Dynamic Discovery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenRouter provider path - Model Catalog and Dynamic Discovery Maturity Note

## Summary

OpenRouter model catalog support is strong: OpenClaw ships static defaults, dynamic `/models` capability loading, nested OpenRouter ref parsing, metadata-only and probed free-model scanning, live model filters, and model-list behavior for native OpenRouter ids. Coverage is Stable because core catalog and dynamic model behavior are covered by source tests and live-gated catalog tests.

Quality is Beta because OpenRouter's free catalog and upstream model availability are volatile, and archived support discussions repeatedly warn that usable free/tool-capable models can change quickly.

## Category Scope

This category covers static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, `openrouter/auto`, OpenRouter free-model scanning, live-model filters, model picker/list behavior, and cache behavior for OpenRouter `/models`.

## Features

- Static catalog rows: Covers Static catalog rows across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- Dynamic /models discovery: Covers Dynamic /models discovery across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- openrouter/auto and nested refs: Covers openrouter/auto and nested refs across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- Free-model scan/probe: Covers Free-model scan/probe across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- Model list/picker cache: Covers Model list/picker cache across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Source includes static catalog defaults, dynamic capability resolution from OpenRouter `/models`, disk and memory cache layers, nested ref parsing, scanner docs, and live-gated catalog tests.
- Negative signals: Live catalog and probe behavior depends on external OpenRouter availability and key state; always-on tests primarily validate parsing and mocked capability behavior.
- Integration gaps: Add scheduled release proof that runs `openclaw models scan --no-probe`, a probed scan with a key, and a model-list/picker check against at least one newly added OpenRouter model id.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: The broad OpenRouter issue query returned #10687 for fully dynamic model discovery, #80347 for stale/delisted model entries after configure, #7006 for exposing the actual model used by `openrouter/auto`, and #68066 for cost accuracy on routed models.
- Discrawl reports: Discord search found community guidance to run `openclaw models scan`, warnings that free models disappear or stop being tool-capable, and advice to use `--no-probe` when tool-capable scan fails.
- Good qualities: Dynamic capability detection reduces hardcoded catalog churn; docs explicitly tell users that probing needs a key and metadata-only output is informational.
- Bad qualities: `openrouter/auto` and free-model routing can hide which backend actually handled the request, and users must rerun scans as OpenRouter's catalog changes.
- Excluded from quality: Catalog test depth and live-gated scan tests are Coverage inputs only.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/openrouter-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Static catalog rows, Dynamic /models discovery, openrouter/auto and nested refs, Free-model scan/probe, Model list/picker cache.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- OpenRouter free-model availability is volatile enough that docs need recurring calibration.
- Metadata-only scans can identify candidates but cannot prove a configured model will work for tool-enabled agent sessions.
- `openrouter/auto` still has transparency and routed-model cost gaps in archived issues.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openrouter.md` documents `openrouter/auto`, concrete `openrouter/<provider>/<model>` refs, and Kimi fallback examples.
- `/Users/kevinlin/code/openclaw/docs/concepts/models.md` documents OpenRouter free-model scanning, metadata-only mode, probing requirements, ranking, and fallback selection.
- `/Users/kevinlin/code/openclaw/docs/cli/models.md` documents nested OpenRouter refs and `models scan`.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md` lists OpenRouter in the bundled provider table and summarizes route-specific quirks.

### Source

- `/Users/kevinlin/code/openclaw/extensions/openrouter/provider-catalog.ts` defines the static OpenRouter catalog and base URL normalization.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/index.ts` implements dynamic model resolution and calls `loadOpenRouterModelCapabilities`.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/openrouter-model-capabilities.ts` implements the OpenRouter `/models` cache, parsing, fetch, and model capability lookup.
- `/Users/kevinlin/code/openclaw/src/commands/models/scan.ts` implements OpenRouter free-model scanning and probing.
- `/Users/kevinlin/code/openclaw/src/agents/live-model-filter.ts` curates OpenRouter live-model candidates.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/openrouter/openrouter.live.test.ts` live-gates OpenRouter model catalog checks and dynamic model completion.
- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` verifies canonical OpenRouter native ids in model-list output.
- `/Users/kevinlin/code/openclaw/src/commands/models.set.e2e.test.ts` covers model set behavior through the CLI.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/openrouter/index.test.ts` verifies dynamic provider registration, native ids, base URL normalization, and catalog behavior.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/openrouter-model-capabilities.test.ts` covers context/max-token parsing, old-cache invalidation, tool support metadata, and cache-miss behavior.
- `/Users/kevinlin/code/openclaw/src/commands/models/scan.test.ts` covers scanning and probe selection behavior.
- `/Users/kevinlin/code/openclaw/src/agents/model-compat.test.ts` covers curated OpenRouter live-model matrix behavior.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenRouter models scan openrouter auto dynamic capabilities model refs"`

Results:

- Returned no direct hits for the exact phrase.

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenRouter"`

Results:

- Returned #10687 on fully dynamic model discovery, #80347 on stale/delisted model entries, #7006 on `openrouter/auto` routed-model transparency, #68066 on routed cost reporting, and #63145 on per-model health checks.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "OpenRouter models scan"`

Results:

- Found May and April 2026 community guidance to run `openclaw models scan`, to rerun it frequently because free OpenRouter models change, to use `--no-probe` when tool-capable scans fail, and to treat no-tool plain chat as a temporary recovery mode.
