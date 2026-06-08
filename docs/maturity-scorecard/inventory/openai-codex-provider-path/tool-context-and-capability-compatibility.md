---
title: "OpenAI / Codex provider path - Tool Context and Capability Compatibility Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenAI / Codex provider path - Tool Context and Capability Compatibility Maturity Note

## Summary

Tool and context compatibility has broad but uneven evidence. OpenAI/Codex routes support OpenClaw dynamic tools, strict Responses tools, server-side web search policy, input images, GPT-5 prompt overlays, native Codex plugin apps, context engines around Codex turns, OpenResponses compatibility, and OpenAI-compatible Chat Completions. Coverage is Beta because some capabilities are tested in gateway compatibility lanes while others are harness/plugin-specific. Quality is Beta because users still ask whether provider-native tools pass through, and prior archive evidence includes an `openai-codex` tool-call replay bug.

## Category Scope

This category covers provider-facing tools, context injection, media inputs, native-vs-client tool ownership, OpenAI Responses compatibility, and how OpenAI/Codex models receive OpenClaw runtime context.

## Features

- Tool Context: Covers Tool Context across provider-facing tools, context injection, media inputs, native-vs-client tool ownership, OpenAI Responses compatibility, and how OpenAI/Codex models receive OpenClaw runtime context.
- Capability Compatibility: Covers Capability Compatibility across provider-facing tools, context injection, media inputs, native-vs-client tool ownership, OpenAI Responses compatibility, and how OpenAI/Codex models receive OpenClaw runtime context.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Docs cover native Codex plugin apps, OpenResponses input/tool compatibility, Chat Completions function tools, GPT-5 prompt overlays, and provider capability tables.
- Negative signals: Provider-native tools, Codex-native tools, OpenClaw dynamic tools, and server-side Responses tools are split across distinct runtimes and compatibility surfaces.
- Integration gaps: More end-to-end proof is needed for server-side web search, native Codex plugin apps, and tool-result image replay on current Codex app-server versions.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: #76413 records an `openai-codex` session replay issue after a prior tool call; #78573 shows demand for provider-native web search support in adjacent OpenAI-compatible provider contexts.
- Discrawl reports: A provider-native tools discussion explains that OpenClaw does not automatically pass through provider-native tools like xAI `x_search` because OpenClaw usually executes client-side function tools.
- Good qualities: The implementation has explicit strict-tool conversion, prompt overlay policy, and native plugin app config instead of implicit pass-through.
- Bad qualities: Native provider tools, OpenClaw tools, and Codex app-server tools are conceptually close enough that users can expect the wrong execution owner.
- Excluded from quality: Gateway and unit test coverage was used only for Coverage.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/openai-codex-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Tool Context, Capability Compatibility.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Native provider tool support should be more explicit in model/provider status output.
- Codex native plugin app activation has a narrow V1 boundary and needs more end-to-end examples.
- Tool-call replay and image/tool-result replay need recurring regression attention.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openai.md` documents server-side web search, GPT-5 prompt contribution, non-agent OpenAI APIs, and image/model capability behavior.
- `/Users/kevinlin/code/openclaw/docs/plugins/codex-native-plugins.md` documents native Codex plugin apps, app inventory, restrictive thread app config, and destructive-action policy.
- `/Users/kevinlin/code/openclaw/docs/gateway/openresponses-http-api.md` documents OpenResponses input items, client tools, images, files, and accepted/ignored fields.
- `/Users/kevinlin/code/openclaw/docs/gateway/openai-http-api.md` documents Chat Completions tool contracts and streaming tool shapes.

### Source

- `/Users/kevinlin/code/openclaw/src/llm/providers/openai-responses-tools.ts` converts OpenClaw tools into Responses function tools.
- `/Users/kevinlin/code/openclaw/src/agents/openai-strict-tool-setting.ts` enables strict tools for native OpenAI/Codex routes.
- `/Users/kevinlin/code/openclaw/src/agents/codex-native-web-search.ts` handles native Codex web search policy.
- `/Users/kevinlin/code/openclaw/extensions/openai/native-web-search.ts` registers OpenAI native web-search capability.
- `/Users/kevinlin/code/openclaw/extensions/openai/prompt-overlay.ts` controls GPT-5 prompt overlay behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/openresponses-prompt.ts` builds OpenResponses-compatible agent prompts.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/openresponses-http.test.ts` covers OpenResponses tools, input images/files, and SSE behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/openresponses-parity.test.ts` covers OpenResponses schema parity for input images, input files, assistant phase metadata, and tools.
- `/Users/kevinlin/code/openclaw/src/gateway/openai-http.test.ts` covers Chat Completions function tools, streaming, and image message inputs.
- `/Users/kevinlin/code/openclaw/scripts/e2e/openai-chat-tools-docker.sh` is a Docker E2E for OpenAI-compatible chat tools.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/llm/providers/openai-responses-shared.test.ts` covers strict tool conversion and schema normalization.
- `/Users/kevinlin/code/openclaw/src/agents/openai-responses.reasoning-replay.test.ts` covers tool/reasoning replay order.
- `/Users/kevinlin/code/openclaw/src/config/web-search-codex-config.test.ts` covers Codex web-search config behavior.
- `/Users/kevinlin/code/openclaw/extensions/openai/plugin-registration.contract.test.ts` covers OpenAI plugin capability registration.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenAI web search server-side Responses tool"`

Results:

- Returned #78573 about native web search support for GitHub Copilot GPT models, relevant to provider-native versus OpenClaw tool expectations.

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenAI Responses reasoning replay function_call tool result"`

Results:

- Returned #76413 about `openai-codex` replaying a prior assistant reply after a tool call.

### Discrawl queries

Query: `discrawl search --limit 10 "OpenAI web search server-side Responses tool"`

Results:

- Returned a provider-native tool discussion explaining that OpenClaw normally uses client-side function calling and its own `web_search` tool rather than automatically passing through provider-native tools.

Query: `discrawl search --limit 10 "strict tools OpenAI Responses schema tool_choice"`

Results:

- Returned no matching rows. This was treated as neutral after successful freshness checks.
