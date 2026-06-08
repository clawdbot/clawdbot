---
title: "Local model providers: Ollama, vLLM, SGLang, LM Studio - Diagnostics and Troubleshooting Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Local model providers: Ollama, vLLM, SGLang, LM Studio - Diagnostics and Troubleshooting Maturity Note

## Summary

Local-model diagnostics are useful but still spread across provider docs,
gateway troubleshooting, memory doctor checks, direct curl probes, and runtime
error extraction. The code has structured provider HTTP errors and model-not-
found classification, and docs cover common local backend signatures. The main
weakness is lack of one consolidated status surface that explains configured
provider, reachable endpoint, selected model, memory embedding provider, and
agent-turn readiness together.

## Category Scope

This category covers user-facing diagnostic commands, provider HTTP error
normalization, model-not-found classification, direct local backend probes,
memory-search readiness checks, provider-specific troubleshooting pages, and
archive evidence for LM Studio, Ollama, vLLM, SGLang, and generic local
OpenAI-compatible provider failures.

## Features

- Local provider status: Covers Local provider status across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Backend reachability probes: Covers Backend reachability probes across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Model availability errors: Covers Model availability errors across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Memory readiness diagnostics: Covers Memory readiness diagnostics across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Provider troubleshooting docs: Covers Provider troubleshooting docs across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals:
  - `/Users/kevinlin/code/openclaw/docs/gateway/troubleshooting.md:236`
    through line 278 document direct local backend probes and common
    signatures/fixes.
  - `/Users/kevinlin/code/openclaw/docs/gateway/local-models.md:324` through
    line 350 document local-model troubleshooting and safety checks.
  - `/Users/kevinlin/code/openclaw/src/agents/provider-http-errors.ts:141`
    through line 240 extract provider error details for user-facing failures.
  - `/Users/kevinlin/code/openclaw/src/agents/live-model-errors.ts:1` through
    line 45 classify model-not-found errors.
  - `/Users/kevinlin/code/openclaw/docs/gateway/doctor.md:512` through line
    523 document memory search readiness checks, including provider failures.
- Negative signals:
  - Diagnostics are strong as individual pieces but split by provider, memory,
    gateway, and transport layers.
  - Archive evidence includes repeated local backend timeout, Docker base URL,
    and model availability questions, which indicates the current diagnostic
    path still requires support interpretation.
- Integration gaps:
  - Add one `openclaw doctor local-models` or equivalent smoke that reports
    configured provider, base URL, model list, selected model, embedding
    readiness, and a minimal chat probe in one output.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports:
  - Query `LM Studio timeout local provider` returned issue #87616 and PR
    #81777, showing timeout and local-provider UX pressure.
  - Query `Ollama cron local unreachable` returned issue #79329, PR #82887,
    issue #86044, and PR #62682, showing recurring local endpoint and runtime
    reachability pressure.
- Discrawl reports:
  - Query `LM Studio timeout local provider` returned help trend summaries,
    LM Studio timeout fixes, and repeated local model load/resource guardrail
    failures.
  - Query `Ollama cron local unreachable` returned support guidance checking
    `ollama list`, Docker base URL, `/gateway/models` status, and cron run
    entries.
- Good qualities:
  - The docs provide concrete direct probes instead of generic advice, and
    runtime error extraction preserves provider response bodies and status
    details.
  - Memory doctor checks help detect one common local-model mismatch: chat
    provider working while memory embeddings are missing or unreachable.
- Bad qualities:
  - Users still need to correlate several diagnostic surfaces manually before
    they know whether the problem is endpoint reachability, model selection,
    provider parser behavior, memory embeddings, or resource pressure.
  - Provider-specific troubleshooting pages are uneven in depth.
- Excluded from quality:
  - Test coverage and diagnostic test depth were not used as Quality inputs.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/local-model-providers-ollama-vllm-sglang-lm-studio.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Local provider status, Backend reachability probes, Model availability errors, Memory readiness diagnostics, Provider troubleshooting docs.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- There is no single status command in the evidence set that proves local chat,
  local embedding, provider model list, and one minimal agent turn together.
- Archive evidence suggests timeout and local endpoint reachability remain
  common enough to deserve a more direct guided diagnostic.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/troubleshooting.md:236`
  documents direct local backend probes.
- `/Users/kevinlin/code/openclaw/docs/gateway/troubleshooting.md:253`
  documents common local backend signatures and fixes.
- `/Users/kevinlin/code/openclaw/docs/gateway/local-models.md:324`
  documents local-model troubleshooting and safety.
- `/Users/kevinlin/code/openclaw/docs/providers/ollama.md:207` documents
  Ollama model-run and image smoke checks.
- `/Users/kevinlin/code/openclaw/docs/providers/lmstudio.md:180` documents
  LM Studio JIT load and preload troubleshooting.
- `/Users/kevinlin/code/openclaw/docs/gateway/doctor.md:512` documents memory
  search readiness checks.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/provider-http-errors.ts:141`
  extracts provider error metadata.
- `/Users/kevinlin/code/openclaw/src/agents/provider-http-errors.ts:177`
  defines `ProviderHttpError` details.
- `/Users/kevinlin/code/openclaw/src/agents/live-model-errors.ts:1`
  classifies model-not-found responses.
- `/Users/kevinlin/code/openclaw/extensions/ollama/src/discovery-shared.ts:225`
  returns Ollama discovery results used by setup/status paths.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/commands/model-picker.test.ts:1068`
  exercises setup flow behavior for vLLM.
- `/Users/kevinlin/code/openclaw/src/commands/model-picker.test.ts:1141`
  exercises provider model-picker contribution behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/commands/doctor-memory-search.test.ts:611`
  covers OpenAI-compatible memory readiness checks.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-memory-search.test.ts:693`
  covers skipped probe behavior.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-memory-search.test.ts:709`
  covers missing base URL diagnostics.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-memory-search.test.ts:727`
  covers missing model diagnostics.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "LM Studio timeout local provider" --json --limit 5`

Results:

- Returned issue #87616 and PR #81777, including local-provider timeout and
  diagnostics pressure.

Query: `gitcrawl search openclaw/openclaw --query "Ollama cron local unreachable" --json --limit 5`

Results:

- Returned issue #79329, PR #82887, issue #86044, and PR #62682, which show
  repeated local reachability and runtime-state questions.

### Discrawl queries

Query: `discrawl search --mode hybrid --limit 5 "LM Studio timeout local provider"`

Results:

- Returned help trend summaries and local model load/resource guardrail
  discussions involving LM Studio.

Query: `discrawl search --mode hybrid --limit 5 "Ollama cron local unreachable"`

Results:

- Returned support guidance checking `ollama list`, Docker base URL,
  `/gateway/models`, and cron run entries.
