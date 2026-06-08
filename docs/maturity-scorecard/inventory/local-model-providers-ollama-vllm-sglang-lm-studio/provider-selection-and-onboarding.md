---
title: "Local model providers: Ollama, vLLM, SGLang, LM Studio - Provider Setup, Lifecycle, and Diagnostics Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Local model providers: Ollama, vLLM, SGLang, LM Studio - Provider Setup, Lifecycle, and Diagnostics Maturity Note

## Summary

OpenClaw has a visible local-model entry path: the local-model guide compares
LM Studio, Ollama, vLLM, SGLang, and custom OpenAI-compatible proxies; provider
docs expose quick starts; and setup/model-picker code lets bundled provider
plugins contribute local options. Coverage is broad at the docs and setup-test
level, but not every provider combination has end-to-end live proof through a
fresh install, model selection, gateway turn, and troubleshooting loop.

## Category Scope

Included in this category:

- Provider Selection: Covers Provider Selection across provider choice, `openclaw onboard`, model-picker contributions, non-interactive setup, and related provider selection and onboarding behavior.
- Onboarding: Covers Onboarding across provider choice, `openclaw onboard`, model-picker contributions, non-interactive setup, and related provider selection and onboarding behavior.
- localService configuration: Covers localService configuration across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Process startup and readiness: Covers Process startup and readiness across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Request leases and idle shutdown: Covers Request leases and idle shutdown across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Health checks and restart: Covers Health checks and restart across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Provider recipes: Covers Provider recipes across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Local provider status: Covers Local provider status across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Backend reachability probes: Covers Backend reachability probes across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Model availability errors: Covers Model availability errors across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Memory readiness diagnostics: Covers Memory readiness diagnostics across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Provider troubleshooting docs: Covers Provider troubleshooting docs across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.

## Features

- Provider Selection: Covers Provider Selection across provider choice, `openclaw onboard`, model-picker contributions, non-interactive setup, and related provider selection and onboarding behavior.
- Onboarding: Covers Onboarding across provider choice, `openclaw onboard`, model-picker contributions, non-interactive setup, and related provider selection and onboarding behavior.
- localService configuration: Covers localService configuration across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Process startup and readiness: Covers Process startup and readiness across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Request leases and idle shutdown: Covers Request leases and idle shutdown across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Health checks and restart: Covers Health checks and restart across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Provider recipes: Covers Provider recipes across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Local provider status: Covers Local provider status across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Backend reachability probes: Covers Backend reachability probes across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Model availability errors: Covers Model availability errors across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Memory readiness diagnostics: Covers Memory readiness diagnostics across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Provider troubleshooting docs: Covers Provider troubleshooting docs across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals:
  - `/Users/kevinlin/code/openclaw/docs/gateway/local-models.md:19` lists the
    backend decision table; lines 23-27 include ds4, LM Studio, custom
    OpenAI-compatible proxies, MLX/vLLM/SGLang, and Ollama.
  - `/Users/kevinlin/code/openclaw/docs/gateway/local-models.md:35` gives a
    recommended LM Studio setup; lines 135-180 document generic local proxy
    configuration and exact-origin trust.
  - `/Users/kevinlin/code/openclaw/docs/providers/ollama.md:43` starts the
    Ollama getting-started flow, and lines 75-91 cover non-interactive setup.
  - `/Users/kevinlin/code/openclaw/docs/providers/lmstudio.md:43` sends users
    through `openclaw onboard`; lines 61-94 cover scripted setup and auth
    profile writes.
  - `/Users/kevinlin/code/openclaw/docs/providers/vllm.md:24` and
    `/Users/kevinlin/code/openclaw/docs/providers/sglang.md:25` document
    local OpenAI-compatible server startup, env key opt-in, and model selection.
- Negative signals:
  - The local-provider row spans several provider-specific pages plus gateway
    config and troubleshooting pages, so the happy path is documented but
    fragmented.
  - The matrix evidence found setup and picker tests, but not one live
    cross-provider scenario that proves all four named provider families through
    onboarding and a full agent turn.
- Integration gaps:
  - Add a fresh-install smoke that exercises provider selection, model
    discovery, default-model persistence, and a Gateway turn for LM Studio,
    Ollama, vLLM, and SGLang using local test servers or recorded provider
    fixtures.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports:
  - Query `local model onboarding LM Studio Ollama vLLM SGLang` returned issue
    #81961, requesting dashboard UX to manage multiple model providers,
    including a local provider such as Ollama, vLLM, LM Studio, or SGLang.
- Discrawl reports:
  - Query `local model onboarding LM Studio Ollama vLLM SGLang` returned no
    direct hits.
  - Query `vLLM SGLang local provider` returned Discord mirror comments saying
    current main implements local-model discovery/setup paths and user-facing
    messages explaining local/self-hosted model keyless setup.
- Good qualities:
  - The docs set expectations about hardware, model size, context pressure,
    fallbacks, and the distinction between native Ollama and OpenAI-compatible
    proxies before users hit runtime errors.
  - Provider plugin manifests expose model-picker labels and auth choices, so
    onboarding is not a purely hand-written config path.
- Bad qualities:
  - The user journey still depends on many pages and commands, and archive
    evidence shows demand for a unified model-provider management surface.
  - Provider setup creates a working config, but follow-up diagnosis often
    requires separate status, logs, and troubleshooting pages.
- Excluded from quality:
  - Test coverage, integration depth, and absence of tests were not used as
    Quality inputs.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/local-model-providers-ollama-vllm-sglang-lm-studio.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Provider Selection, Onboarding, localService configuration, Process startup and readiness, Request leases and idle shutdown, Health checks and restart, Provider recipes, Local provider status, Backend reachability probes, Model availability errors, Memory readiness diagnostics, Provider troubleshooting docs.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- One operator-facing dashboard or status surface for "local model provider is
  configured, reachable, selected, and usable" is still a recurring request.
- The docs need clearer route markers for users deciding between native Ollama,
  LM Studio Responses API, and generic OpenAI-compatible local proxies.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/local-models.md:10` frames local
  models as possible but hardware-, context-, and safety-sensitive.
- `/Users/kevinlin/code/openclaw/docs/gateway/local-models.md:21` lists backend
  choices and use cases.
- `/Users/kevinlin/code/openclaw/docs/providers/lmstudio.md:61` documents
  non-interactive LM Studio onboarding.
- `/Users/kevinlin/code/openclaw/docs/providers/ollama.md:75` documents
  non-interactive Ollama onboarding.
- `/Users/kevinlin/code/openclaw/docs/providers/vllm.md:64` and
  `/Users/kevinlin/code/openclaw/docs/providers/sglang.md:64` document implicit
  model discovery.

### Source

- `/Users/kevinlin/code/openclaw/extensions/lmstudio/index.ts:122` contributes
  LM Studio model-picker labels and hints.
- `/Users/kevinlin/code/openclaw/extensions/ollama/index.ts:208` contributes
  Ollama auth-choice and model-selection metadata.
- `/Users/kevinlin/code/openclaw/extensions/vllm/index.ts:77` contributes vLLM
  provider-picker metadata.
- `/Users/kevinlin/code/openclaw/extensions/sglang/index.ts:80` contributes
  SGLang provider-picker metadata.
- `/Users/kevinlin/code/openclaw/src/plugins/provider-self-hosted-setup.ts:256`
  builds the self-hosted OpenAI-compatible provider config used by vLLM and
  SGLang setup.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/commands/model-picker.test.ts:1068`
  verifies configuring vLLM during setup.
- `/Users/kevinlin/code/openclaw/src/commands/model-picker.test.ts:1141`
  verifies provider model-picker contributions, including Ollama, win over
  legacy entries.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/plugins/provider-self-hosted-setup.test.ts:399`
  verifies non-interactive vLLM and SGLang config plus auth-profile writes.
- `/Users/kevinlin/code/openclaw/extensions/lmstudio/src/setup.test.ts:301`
  covers non-interactive LM Studio setup.
- `/Users/kevinlin/code/openclaw/extensions/ollama/src/setup.test.ts:642`
  covers non-interactive Ollama setup.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "local model onboarding LM Studio Ollama vLLM SGLang" --json --limit 5`

Results:

- Returned open issue #81961, "[Feature]: Add a simple Dashboard UX to manage
  multiple model providers", explicitly naming local providers such as Ollama,
  vLLM, LM Studio, and SGLang.

### Discrawl queries

Query: `discrawl search --mode hybrid --limit 5 "local model onboarding LM Studio Ollama vLLM SGLang"`

Results:

- No direct hits returned.

Query: `discrawl search --mode hybrid --limit 5 "vLLM SGLang local provider"`

Results:

- Returned a Discord mirror comment for issue #15779 stating current main
  implements local-model discovery/setup for Ollama, LM Studio, vLLM, and
  SGLang, plus maintainer discussion of keyless local/self-hosted setup.
