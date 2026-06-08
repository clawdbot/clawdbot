---
title: "Local model providers: Ollama, vLLM, SGLang, LM Studio - Local Service Lifecycle and Readiness Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Local model providers: Ollama, vLLM, SGLang, LM Studio - Local Service Lifecycle and Readiness Maturity Note

## Summary

OpenClaw has a real local-service lifecycle layer for provider-backed local
model processes: provider config can declare a `localService`, request
transport acquires the service before sending traffic, and service code handles
health probes, startup serialization, idle shutdown, and restart of unhealthy
processes. Coverage is strongest for the lifecycle manager itself and weaker
for provider-specific live services such as Ollama, vLLM, SGLang, or LM Studio
being exercised end to end from a fresh operator install.

## Category Scope

This category covers the `localService` config contract, process startup,
readiness probes, lease/release behavior during provider requests, idle
shutdown, health checks, and the handoff from selected provider model metadata
into transport-level local-service orchestration.

## Features

- localService configuration: Covers localService configuration across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Process startup and readiness: Covers Process startup and readiness across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Request leases and idle shutdown: Covers Request leases and idle shutdown across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Health checks and restart: Covers Health checks and restart across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Provider recipes: Covers Provider recipes across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals:
  - `/Users/kevinlin/code/openclaw/docs/gateway/local-model-services.md:10`
    documents `localService` as an optional provider process manager, and
    lines 18-27 explain cold start, lease, health check, and idle stop
    behavior.
  - `/Users/kevinlin/code/openclaw/docs/gateway/local-model-services.md:32`
    through line 67 gives a working provider config example, and lines 69-82
    define the supported fields.
  - `/Users/kevinlin/code/openclaw/src/agents/provider-local-service.ts:57`
    through line 132 implement the service registry and lease model; lines
    199-280 implement startup, readiness waiting, and failure handling.
  - `/Users/kevinlin/code/openclaw/src/agents/provider-transport-fetch.ts:522`
    through line 657 attach local-service acquisition and release to the
    guarded provider fetch path.
- Negative signals:
  - The lifecycle layer is generic and well tested, but archive and source
    evidence did not show a fresh live run that starts a real Ollama, vLLM,
    SGLang, or LM Studio service and then proves an agent request.
  - The docs are oriented to advanced config authors; provider-specific pages
    do not consistently route users from local provider setup into
    `localService` automation.
- Integration gaps:
  - Add an integration smoke using a tiny local HTTP fixture that starts
    through `localService`, serves `/v1/models` and chat completion endpoints,
    and proves one gateway turn plus idle shutdown.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports:
  - Query `localService local model server` returned no direct hits, which
    suggests few public issues name the lifecycle abstraction directly.
- Discrawl reports:
  - Query `localService local model server` returned no direct hits.
- Good qualities:
  - The implementation validates command shape, supports health headers,
    serializes cold starts, releases leases after request completion, and
    restarts services that become unhealthy.
  - Request routing keeps the service abstraction close to provider transport
    rather than requiring every caller to manage process readiness.
- Bad qualities:
  - Operator feedback is still indirect: users generally diagnose the provider
    server, config, and gateway route separately instead of seeing one unified
    readiness state.
  - The abstraction is documented as configuration machinery, not as a
    first-class guided local-model setup experience.
- Excluded from quality:
  - Test coverage, integration depth, and absence of live provider-service
    tests were not used as Quality inputs.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/local-model-providers-ollama-vllm-sglang-lm-studio.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for localService configuration, Process startup and readiness, Request leases and idle shutdown, Health checks and restart, Provider recipes.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No provider-specific local-service recipe was found for Ollama, LM Studio,
  vLLM, or SGLang that includes a runnable command, health URL, and model
  selection in one path.
- No archive signal shows users talking about `localService` by name, which can
  mean either the abstraction is hidden well or not discoverable enough to
  debug when local process startup fails.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/local-model-services.md:10`
  introduces provider-managed local services.
- `/Users/kevinlin/code/openclaw/docs/gateway/local-model-services.md:32`
  provides a full `localService` config example.
- `/Users/kevinlin/code/openclaw/docs/gateway/local-model-services.md:183`
  lists operational notes for logging, health checks, and idle timeout.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-agents.md:461` includes
  `localService` in provider model config fields.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/provider-local-service.ts:57`
  implements local service acquisition and state tracking.
- `/Users/kevinlin/code/openclaw/src/agents/provider-local-service.ts:141`
  validates service commands and absolute command paths.
- `/Users/kevinlin/code/openclaw/src/agents/provider-local-service.ts:199`
  probes the service health URL.
- `/Users/kevinlin/code/openclaw/src/agents/provider-transport-fetch.ts:522`
  wires local-service acquisition into provider requests.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/model.ts:695`
  attaches local-service metadata to resolved model configuration.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/provider-transport-stream.test.ts:115`
  verifies unsupported APIs fail closed when a local service is attached.
- `/Users/kevinlin/code/openclaw/src/agents/provider-transport-stream.test.ts:179`
  verifies local-service models route through the simple-completion transport.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/provider-local-service.test.ts:75`
  covers start and idle stop.
- `/Users/kevinlin/code/openclaw/src/agents/provider-local-service.test.ts:107`
  covers health headers.
- `/Users/kevinlin/code/openclaw/src/agents/provider-local-service.test.ts:148`
  covers serialized cold starts.
- `/Users/kevinlin/code/openclaw/src/agents/provider-local-service.test.ts:193`
  covers distinct environment handling.
- `/Users/kevinlin/code/openclaw/src/agents/provider-local-service.test.ts:257`
  covers restart after an unhealthy state.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "localService local model server" --json --limit 5`

Results:

- No direct hits returned.

### Discrawl queries

Query: `discrawl search --mode hybrid --limit 5 "localService local model server"`

Results:

- No direct hits returned.
