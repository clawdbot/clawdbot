---
title: "Agent Runtime - Local and Self-hosted Providers Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Agent Runtime - Local and Self-hosted Providers Maturity Note

## Summary

Local and self-hosted provider execution is documented and implemented, with especially detailed Ollama guidance for native `/api/chat`, OpenAI-compatible `/v1`, local markers, auth profile format, tool-support flags, lean profiles, context windows, timeouts, and live smoke commands. Coverage is Beta because it is concentrated in Ollama/local-model docs and command behavior. Quality is Alpha because archive evidence shows local models still struggle with tool calling, cold-start timeouts, raw JSON/tool text, and event-loop blocking.

## Category Scope

This category covers local and self-hosted execution paths visible to users/operators: Ollama, OpenAI-compatible local servers, local model profile configuration, tool-capability flags, timeouts, context windows, local image/model smoke checks, and local provider failure handling.

## Features

- Local provider profiles: Local model profile configuration for Ollama and OpenAI-compatible local servers.
- Tool-capability flags: Local provider capability flags and behavior for tool use.
- Timeouts and context windows: Local provider timeout and context-window configuration.
- Local smoke checks: Local image and model smoke checks visible to operators.
- Local failure handling: Operator-facing failure handling for local and self-hosted providers.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (70%)`

Coverage is useful and operator-facing, but it is uneven across local backends and less uniformly tested than hosted providers.

## Quality Score

- Score: `Alpha (60%)`

Local execution is workable but still fragile in practice: model tool-calling quality, cold starts, context limits, local server blocking, and OpenAI-compatible mode quirks remain recurring issues.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: evaluated against `references/completeness/agent-runtime-and-provider-execution.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Local provider profiles, Tool-capability flags, Timeouts and context windows, Local smoke checks, Local failure handling.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Local provider evidence is strongly Ollama-centered; other local/self-hosted runtimes need the same level of scenario proof.
- Tool-calling behavior depends heavily on model capability and provider mode.
- Timeout guidance exists, but operator defaults still produce reports for slow local LLMs.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/ollama.md` documents native `/api/chat`, `/v1` warnings, raw tool JSON behavior, local auth rules, provider IDs, `models list`, exact `/model ollama` failure behavior, endpoint preflight, live test command, custom base URLs, `compat.supportsTools: false`, `localModelLean`, `timeoutSeconds`, OpenAI-compatible mode tool/streaming reliability warnings, context windows, streaming/tool-calling/thinking support, garbled output handling, and cold local model timeouts.
- `/Users/kevinlin/code/openclaw/docs/concepts/models.md` documents local/GGUF refs, model allowlists, and runtime-independent model refs.
- `/Users/kevinlin/code/openclaw/docs/cli/agent.md` documents `--local`, timeout options, and embedded fallback behavior for local agent runs.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/agent-tools.ts` applies model-provider tool policy and suppresses tools such as web search for local lean profiles.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/model-selection.ts` resolves model allowlists, local refs, thinking/reasoning settings, and context token limits used by local providers.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.ts` handles context-window hints, local/embedded runtime fallback behavior, provider timeout copy, and local model retry/fallback interactions.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` covers local/provider behavior in model catalog/status output.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` covers context-aware reserve token floors, overflow recovery text, local/runtime fallback interactions, model capacity copy, and timeout/fallback diagnostics relevant to local providers.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/agent-tools.message-provider-policy.test.ts` covers provider-based tool policy behavior.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` includes unit-style coverage for context windows, provider fallback state, and timeout/failure copy.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "Ollama vLLM SGLang LM Studio tool calling"` returned no matches for the exact backend set.
- `gitcrawl --json search issues -R openclaw/openclaw "local model provider context timeout Ollama"` returned #87642 on exposing `waitForRun` timeout for slow local LLMs, #86599 on local model provider calls blocking the gateway event loop on Windows, #74204 on memory embed timeout for local GGUF, #81214 on subagent regression, and #65502 on resilient model fallback with retry and safe mode.
- `gitcrawl --json search prs -R openclaw/openclaw "Ollama native tool calling streaming"` returned no matching PRs.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "Ollama tool calling OpenClaw"` returned guidance that some local models are poor at tool calling, user questions about local model limitations and tool use, maintainer guidance that raw tools printed as text indicate model/tool-calling compatibility problems, and comments closing issues around local backend support and Ollama `/v1` misconfiguration.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "models list provider routing fallback"` returned user-helping-user guidance on Ollama provider versus session/tool pressure and local/custom provider handling.
- `/Users/kevinlin/.local/bin/discrawl search --limit 10 "usage limit fallback openai-codex"` included adjacent operator discussions about fallback configuration, useful as contrast but not primary local-provider evidence.
