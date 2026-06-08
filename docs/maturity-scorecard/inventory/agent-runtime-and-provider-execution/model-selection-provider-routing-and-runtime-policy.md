---
title: "Agent Runtime - Model and Runtime Selection Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Agent Runtime - Model and Runtime Selection Maturity Note

## Summary

Model selection and provider routing are among the most mature parts of this surface. Docs explain model refs, configured defaults, user-selected strict refs, provider fallbacks, auth-profile fallbacks, `/model`, runtime overrides, and thinking/context policy. Source centralizes most state in `createModelSelectionState`, and tests cover model list/set behavior plus fallback/retry routing. Quality is Beta because archive evidence shows recent drift around Codex OAuth routes, stale `openai-codex` refs, and per-session/provider fallback state.

## Category Scope

This category covers selecting a model/provider/runtime for an agent turn, honoring user and config choices, resolving thinking/context settings, handling runtime provider overrides, and preserving or clearing invalid route state.

## Features

- Model reference selection: Selecting the model reference for an agent turn from user or configured defaults.
- Provider and runtime overrides: Handling provider selection and runtime overrides for a turn.
- Thinking and context settings: Resolving thinking and context settings as part of model selection.
- Invalid route recovery: Preserving or clearing invalid route state when selections drift or fail.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`

Coverage is strong across model docs, CLI command docs, provider docs, source, and e2e tests for model list/set and fallback normalization.

## Quality Score

- Score: `Beta (72%)`

Routing behavior is explicit and defensive, but quality is pulled down by recent operator-visible route repair, stale auth/provider refs, and fallback stickiness reports.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/agent-runtime-and-provider-execution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Model reference selection, Provider and runtime overrides, Thinking and context settings, Invalid route recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Operator recovery for stale provider/runtime refs is spread across doctor behavior, provider docs, and error copy.
- Runtime policy is strong for common providers but field reports show route drift when Codex OAuth, custom provider IDs, and fallback profiles interact.
- The system needs recurring release-level scenario proof for route repair and fallback reset behavior.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/concepts/models.md` documents model refs versus runtime, selection order, provider/auth fallbacks, configured defaults, auto fallback selections, strict user session selections, model allowlists, local/GGUF refs, `/model` switching, live switching, and strict selected refs.
- `/Users/kevinlin/code/openclaw/docs/cli/models.md` documents `models list`, `models set`, status/probe options, catalog/auth columns, provider catalog responsiveness, ref parsing/fallback, auth profiles, login, paste-api-key, and OpenAI API versus ChatGPT/OAuth routing.
- `/Users/kevinlin/code/openclaw/docs/providers/openai.md` documents OpenAI/Codex route distinctions, naming map, GPT-5.5/Codex app-server repair notes, capability tables, and the default OpenAI agent route summary.
- `/Users/kevinlin/code/openclaw/docs/concepts/agent-runtimes.md` documents runtime selection, fail-closed explicit runtimes, CLI backend aliases, and OpenAI defaulting to the Codex harness.

### Source

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/model-selection.ts` implements provider/model initialization, allowlists, catalog visibility policy, direct stored override handling, stale legacy `openai-codex` override clearing, auth profile override validation, thinking/reasoning resolution, and context token resolution.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.ts` applies fallback candidate auth profiles, live model switches, runtime config, runtime provider resolution, and retry state.
- `/Users/kevinlin/code/openclaw/src/agents/configured-provider-fallback.ts` defines configured fallback behavior for provider selection.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/commands/models.set.e2e.test.ts` covers model setting and fallback normalization.
- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` covers model list/status, catalog/auth/local/provider behavior, and provider visibility.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` covers fallback rechecks, stale queued probe dropping after user model switches, preserving and re-persisting fallback origins, CLI runtime override boundaries, model capacity errors, live model switch restarts, and retry-loop caps.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` includes focused tests for provider/model fallback retry state, auth profile preservation, dropping `authProfileId` when fallback switches providers, and same-provider auth profile fallback.
- `/Users/kevinlin/code/openclaw/src/commands/models.auth.provider-resolution.test.ts` covers auth-provider resolution behavior for model commands.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "models list model selection fallback auth profile provider"` returned #59168 on using `provider/name` as the internal model key, #83954 on Pro-plan paths for `gpt-5.5-pro` and retired Spark via Codex CLI/app-server, and #70055 on disabling external CLI sync for auth profiles via config.
- `gitcrawl --json search issues -R openclaw/openclaw "No API key found provider openai-codex auth profile"` returned stale route and Codex OAuth issues including #86470 on doctor rewriting `openai-codex/*` to `openai/*`, #83223 on migrated routes still looking up `openai-codex` auth before fallback, and #86820 on compaction falling back to direct OpenAI API.
- `gitcrawl --json search issues -R openclaw/openclaw "rate limit fallback usage limit openai-codex"` returned #85103 on provider-wide quota fallback not triggering, #87467 on auto rate-limit fallback staying pinned after primary recovery, #79604 on rotating auth profiles before provider fallback, and #79611 on active-memory plugin failover.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "models list provider routing fallback"` returned a May 16 beta announcement emphasizing Codex app-server reliability, progress timeouts, compaction handling, tool policy enforcement, OAuth fallback, local/custom providers, and guidance on Ollama provider pressure, vision routing, CLI crashes, and per-turn model routing with `before_model_resolve`.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "openai-codex provider routing"` returned maintainer notes around OpenAI OAuth/Codex routing, `openai-codex` being load-bearing in auth profile resolution, compaction routing, context config, auth order, and stale persisted route state.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "model fallback decision"` returned recent discussions about openai-codex timeouts, fallback decisions, No API key fallback decisions, OpenRouter timeouts, and session repair loops.
