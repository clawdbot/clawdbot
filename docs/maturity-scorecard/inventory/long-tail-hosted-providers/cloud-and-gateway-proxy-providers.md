---
title: "Long-tail hosted providers - Cloud and Gateway Providers Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Long-tail hosted providers - Cloud and Gateway Providers Maturity Note

## Summary

Cloud and gateway proxy providers are Alpha. Provider manifests and docs cover
the surface, and GitHub Copilot/OpenCode have live paths, but Bedrock,
Cloudflare AI Gateway, Vercel AI Gateway, LiteLLM, and similar proxies have
thinner runtime proof and more credential/route ambiguity.

## Category Scope

This note covers Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel
AI Gateway, LiteLLM, Microsoft Foundry, GitHub Copilot, OpenCode, OpenCode Go,
and Kilo Gateway.

Out of scope: OpenRouter as a separately scored hosted aggregator, local proxy
providers such as local LM Studio/vLLM/SGLang, and first-party OpenAI/Anthropic
providers.

## Features

- Bedrock setup: Covers Bedrock setup across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Gateway/proxy routing: Covers Gateway/proxy routing across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Copilot/OpenCode hosted access: Covers Copilot/OpenCode hosted access across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Proxy capability diagnostics: Covers Proxy capability diagnostics across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (58%)`
- Positive signals:
  - Provider directory and model-provider docs list Bedrock, Bedrock Mantle, Cloudflare AI Gateway, LiteLLM, Vercel AI Gateway, GitHub Copilot, Kilo Gateway, and OpenCode/OpenCode Go.
  - Manifests exist for Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, LiteLLM, Microsoft Foundry, GitHub Copilot, OpenCode, OpenCode Go, and Kilo.
  - GitHub Copilot has a live token/model path.
  - OpenCode has a live hosted text path and model setup docs.
  - Unit coverage exists for Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, LiteLLM, GitHub Copilot, OpenCode, and Kilo.
- Negative signals:
  - Cloud/gateway proxy providers do not share a single recurring live smoke lane.
  - Bedrock and gateway proxies have weaker end-to-end proof than direct hosted provider adapters.
  - Cloud/gateway proxy success often depends on upstream route selection, credentials, base URL, and account policy outside OpenClaw.

## Quality Score

- Score: `Alpha (56%)`
- Good qualities:
  - Docs separate bundled provider plugins from custom `models.providers` proxy/base URL configuration.
  - Bedrock is represented as a provider plugin and as official external catalog metadata.
  - GitHub Copilot and OpenCode paths are more mature than the rest of this component.
  - Provider docs explain gateway/proxy behavior and credential expectations.
- Bad qualities:
  - Proxy/gateway providers compound failures from OpenClaw config, provider credentials, upstream gateway routing, upstream model capability, and remote account state.
  - Bedrock's AWS SDK credential chain does not behave like normal API-key providers, and Discord support history shows this needs explicit diagnosis.
  - Cloudflare AI Gateway, Vercel AI Gateway, LiteLLM, and Microsoft Foundry have less uniform credential, route, and account-behavior documentation than the stronger Copilot/OpenCode paths.
- Excluded from quality:
  - Unit, integration, and live evidence were used only for Coverage scoring.

## Completeness Score

- Score: `Alpha (58%)`
- Surface instructions: evaluated against `references/completeness/long-tail-hosted-providers.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Bedrock setup, Gateway/proxy routing, Copilot/OpenCode hosted access, Proxy capability diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live provider smoke for Bedrock, Vercel AI Gateway, Cloudflare AI Gateway,
  LiteLLM, and Microsoft Foundry with clear opt-in credential controls.
- Add a proxy/gateway diagnostic page that separates OpenClaw config errors from
  upstream gateway, AWS profile, and model-capability errors.
- Add a route/capability table for proxy providers covering tool, image,
  reasoning, and fallback behavior.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/index.md:28`: provider directory links Amazon Bedrock.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:29`: provider directory links Amazon Bedrock Mantle.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:36`: provider directory links Cloudflare AI Gateway.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:43`: provider directory links GitHub Copilot.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:49`: provider directory links Kilo.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:50`: provider directory links LiteLLM.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:58`: provider directory links OpenCode.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:59`: provider directory links OpenCode Go.
- `/Users/kevinlin/code/openclaw/docs/providers/index.md:72`: provider directory links Vercel AI Gateway.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:343`: docs explain `models.providers` for custom providers and OpenAI/Anthropic-compatible proxies.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:345`: docs say many bundled provider plugins already publish a default catalog, and explicit `models.providers` entries are for overrides.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:263`: docs link Z.AI and Vercel AI Gateway setup references.

### Source

- `/Users/kevinlin/code/openclaw/extensions/amazon-bedrock/openclaw.plugin.json:2`: Amazon Bedrock provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/amazon-bedrock-mantle/openclaw.plugin.json:2`: Amazon Bedrock Mantle provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/cloudflare-ai-gateway/openclaw.plugin.json:2`: Cloudflare AI Gateway provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/vercel-ai-gateway/openclaw.plugin.json:2`: Vercel AI Gateway provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/litellm/openclaw.plugin.json:2`: LiteLLM provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/microsoft-foundry/openclaw.plugin.json:2`: Microsoft Foundry provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/github-copilot/openclaw.plugin.json:2`: GitHub Copilot provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/opencode/openclaw.plugin.json:2`: OpenCode provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/opencode-go/openclaw.plugin.json:2`: OpenCode Go provider manifest exists.
- `/Users/kevinlin/code/openclaw/extensions/kilocode/openclaw.plugin.json:2`: Kilo provider manifest exists.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/github-copilot/connection-bound-ids.live.test.ts:148`: GitHub Copilot live test starts token exchange and model access checks.
- `/Users/kevinlin/code/openclaw/extensions/opencode/opencode.live.test.ts:18`: OpenCode live test sets up DeepSeek live model config for the hosted provider path.
- `/Users/kevinlin/code/openclaw/extensions/opencode/opencode.live.test.ts:60`: OpenCode live test covers thinking replay after tool-call context.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:414`: docs list OpenRouter and OpenCode among aggregators and alternate gateways to include when keys are enabled.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/amazon-bedrock/index.test.ts`: unit coverage for Bedrock provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/amazon-bedrock-mantle/index.test.ts`: unit coverage for Bedrock Mantle provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/cloudflare-ai-gateway/index.test.ts`: unit coverage for Cloudflare AI Gateway behavior.
- `/Users/kevinlin/code/openclaw/extensions/vercel-ai-gateway/provider-catalog.test.ts`: unit coverage for Vercel AI Gateway provider catalog behavior.
- `/Users/kevinlin/code/openclaw/extensions/litellm/index.test.ts`: unit coverage for LiteLLM provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/github-copilot/index.test.ts`: unit coverage for GitHub Copilot provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/kilocode/index.test.ts`: unit coverage for Kilo provider behavior.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "Bedrock Cloudflare Vercel LiteLLM provider"` returned `[]`.
- `gitcrawl --json search prs -R openclaw/openclaw "Bedrock Cloudflare Vercel LiteLLM provider"` returned #87202 only, which is adjacent and weak evidence.
- `gitcrawl --json search prs -R openclaw/openclaw "provider metadata model catalog"` returned metadata/catalog changes including #85345, #83292, and #43493 that are relevant to provider/gateway metadata churn.

### Discrawl queries

- `env DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search "Bedrock Cloudflare Vercel LiteLLM provider" --limit 5` returned a support answer listing Bedrock, LiteLLM, Vercel AI Gateway, and Cloudflare AI Gateway as options, and noting that gateway layers can help with routing, retries, and observability.
- `env DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search "provider auth setup env vars" --limit 5` returned Bedrock support guidance explaining that Bedrock uses the AWS SDK credential chain and that AWS errors mean the Gateway cannot see AWS credentials.
