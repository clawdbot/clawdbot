---
title: "Long-tail hosted providers - Regional Hosted LLM Providers Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Long-tail hosted providers - Regional Hosted LLM Providers Maturity Note

## Summary

Regional hosted LLM providers are Alpha. OpenClaw has broad manifest/docs
coverage and selected live paths for Kimi, MiniMax, BytePlus, and Xiaomi, but
regional account plans, endpoint variants, model IDs, and provider-specific
features keep runtime proof uneven.

## Category Scope

This note covers Qwen, Alibaba, Tencent, Qianfan, ZAI, Moonshot/Kimi, StepFun,
MiniMax, BytePlus, Volcengine, and Xiaomi hosted provider families.

Out of scope: OpenRouter-hosted access to the same models, local model routes,
and generic media generation providers except where the regional provider owns
the provider path.

## Features

- Regional provider setup: Covers Regional provider setup across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.
- Region and plan routing: Covers Region and plan routing across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.
- Regional live smoke: Covers Regional live smoke across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.
- Account prerequisite diagnostics: Covers Account prerequisite diagnostics across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (64%)`
- Positive signals:
  - Provider docs and manifests exist for many regional providers.
  - `docs/concepts/model-providers.md` lists regional provider ids, auth env vars, and examples for BytePlus, Kimi, MiniMax, Moonshot, Qianfan, Qwen, StepFun, Volcengine, Xiaomi, and ZAI.
  - Moonshot/Kimi and MiniMax live tests cover provider-owned web-search tools.
  - BytePlus and Xiaomi live tests cover provider-specific hosted routes.
  - Shared media live suites include Alibaba, BytePlus, MiniMax, Qwen, and related hosted providers.
- Negative signals:
  - Several providers have manifest/source coverage without equivalent text-generation live proof.
  - Plan variants and regional endpoint choices create nonuniform auth/setup behavior.
  - Archive queries for the exact regional provider phrase returned little direct GitHub evidence.

## Quality Score

- Score: `Alpha (60%)`
- Good qualities:
  - Regional providers use plugin-owned manifests and setup/auth metadata instead of custom user config alone.
  - Onboard docs prefilter provider choices and fall back when no models are loaded.
  - MiniMax, Moonshot/Kimi, BytePlus, and Xiaomi keep provider-specific routing and feature behavior in dedicated plugins.
- Bad qualities:
  - Regional providers have high variance in plan availability, region, endpoint, model ID, OAuth/API-key shape, and hosted feature behavior.
  - Some providers share model families across providers, OpenRouter, plan routes, and local/proxy paths, making user-facing routing easy to confuse.
  - Discord evidence shows provider registry key lists and auth/model parameter confusion around regional providers.
- Excluded from quality:
  - Unit, integration, and live evidence were used only for Coverage scoring.

## Completeness Score

- Score: `Alpha (64%)`
- Surface instructions: evaluated against `references/completeness/long-tail-hosted-providers.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Regional provider setup, Region and plan routing, Regional live smoke, Account prerequisite diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add one representative recurring text live smoke per regional provider family.
- Add a generated regional provider route table that separates native hosted,
  plan, OpenRouter, and local/proxy paths.
- Add account/region prerequisites to every regional provider doc.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/index.md:27`: provider docs include Alibaba Model Studio.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:33`: provider directory links BytePlus through model provider concepts.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:52`: provider docs include MiniMax.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:54`: provider docs include Moonshot AI.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:62`: provider docs include Qianfan.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:63`: provider docs include Qwen Cloud.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:67`: provider docs include StepFun.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:69`: provider docs include Tencent Cloud.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:74`: provider docs include Volcengine.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:77`: provider docs include Xiaomi.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:78`: provider docs include Z.AI.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:295`: bundled provider table lists BytePlus, Kimi, MiniMax, Moonshot, Qianfan, Qwen, StepFun, Volcengine, Xiaomi, and ZAI-style routes.
- `/Users/kevinlin/code/openclaw/docs/cli/onboard.md:216`: onboarding prefilters provider choices and documents Volcengine/BytePlus plan variants.

### Source

- `/Users/kevinlin/code/openclaw/extensions/qwen/openclaw.plugin.json:2`: Qwen ships as a provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/alibaba/openclaw.plugin.json:2`: Alibaba ships as a provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/tencent/openclaw.plugin.json:2`: Tencent ships as a provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/qianfan/openclaw.plugin.json:2`: Qianfan ships as a provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/zai/openclaw.plugin.json:2`: ZAI ships as a provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/moonshot/openclaw.plugin.json:2`: Moonshot ships as a provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/stepfun/openclaw.plugin.json:2`: StepFun ships as a provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/minimax/openclaw.plugin.json:2`: MiniMax ships as a provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/byteplus/openclaw.plugin.json:2`: BytePlus ships as a provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/volcengine/openclaw.plugin.json:2`: Volcengine ships as a provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/xiaomi/openclaw.plugin.json:2`: Xiaomi ships as a provider plugin.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/moonshot/moonshot.live.test.ts:21`: Moonshot live test runs Kimi web search through the provider tool.
- `/Users/kevinlin/code/openclaw/extensions/minimax/minimax.live.test.ts:37`: MiniMax live test runs provider-owned web search.
- `/Users/kevinlin/code/openclaw/extensions/minimax/minimax.live.test.ts:53`: MiniMax live test synthesizes TTS through the registered provider.
- `/Users/kevinlin/code/openclaw/extensions/byteplus/live.test.ts:25`: BytePlus live test returns assistant text and handles subscription errors.
- `/Users/kevinlin/code/openclaw/extensions/xiaomi/xiaomi.live.test.ts:20`: Xiaomi live test covers provider TTS.
- `/Users/kevinlin/code/openclaw/extensions/video-generation-providers.live.test.ts:97`: shared video-generation live cases include Alibaba, BytePlus, MiniMax, Qwen, and related hosted providers.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/qwen/video-generation-provider.test.ts`: unit coverage for Qwen video-generation provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/zai/index.test.ts`: unit coverage for ZAI provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/moonshot/index.test.ts`: unit coverage for Moonshot provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/minimax/speech-provider.test.ts`: unit coverage for MiniMax speech provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/byteplus/index.test.ts`: unit coverage for BytePlus provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/volcengine/tts.test.ts`: unit coverage for Volcengine TTS behavior.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "Qwen ZAI Moonshot MiniMax provider"` returned `[]`.
- `gitcrawl --json search prs -R openclaw/openclaw "Qwen ZAI Moonshot MiniMax provider"` returned `[]`.
- `gitcrawl --json search prs -R openclaw/openclaw "provider metadata model catalog"` returned adjacent provider metadata/catalog PRs, including Qwen and provider model metadata changes such as #69729 and #43493.

### Discrawl queries

- `env DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search "Qwen ZAI Moonshot MiniMax provider" --limit 5` returned a Discord voice/STT issue report where provider registry keys included Deepgram, Groq, MiniMax, Mistral, Moonshot, OpenRouter, Qwen, and ZAI, and the user hit an OpenAI STT model-parameter issue.
- `env DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search "provider auth setup env vars" --limit 5` returned a review comment where `QWEN_API_KEY` and `MOONSHOT_API_KEY` could affect image-tool provider auto-selection.
