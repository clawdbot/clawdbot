---
summary: "Use Ollama Cloud directly with OpenClaw"
read_when:
  - You want to use hosted Ollama models without a local Ollama server
  - You need the ollama-cloud provider id, key, or endpoint
title: "Ollama Cloud"
---

Ollama Cloud is Ollama's hosted model API. It lets OpenClaw call Ollama-hosted
models directly, without installing a local Ollama server or signing a local
Ollama app into cloud mode. Use provider id `ollama-cloud` and model refs like
`ollama-cloud/kimi-k2.6`.

This page is for direct cloud-only routing. The provider uses Ollama's native
`/api/chat` style, not the OpenAI-compatible `/v1` route. OpenClaw registers it
as a separate provider id so cloud-only credentials, live catalog discovery, and
model selection do not get mixed with a local `ollama` host.

Use this page when you want cloud-only routing. For local Ollama, hybrid
cloud-plus-local routing, embeddings, and custom host details, see
[Ollama](/providers/ollama).

## Setup

Create an Ollama Cloud API key at [ollama.com/settings/keys](https://ollama.com/settings/keys), then run:

```bash
openclaw onboard --auth-choice ollama-cloud
```

Or set:

```bash
export OLLAMA_API_KEY="<your-ollama-cloud-api-key>" # pragma: allowlist secret
```

## Defaults

- Provider: `ollama-cloud`
- Base URL: `https://ollama.com`
- Env var: `OLLAMA_API_KEY`
- API style: Ollama native `/api/chat`
- Example model: `ollama-cloud/kimi-k2.6`

## When to choose Ollama Cloud

- You want hosted Ollama models without running `ollama serve` locally.
- You want the same native Ollama chat API shape OpenClaw uses for local
  Ollama, but pointed at `https://ollama.com`.
- You want a simple cloud path for models that are already in Ollama's hosted
  catalog.
- You do not need local model pulls, local GPU control, or LAN-only inference.

Use [Ollama](/providers/ollama) instead when you want local-only or
cloud-plus-local routing through a signed-in Ollama host. Use an
OpenAI-compatible provider instead when you need `/v1/chat/completions`
semantics or provider-specific OpenAI-style features.

## Models

OpenClaw discovers Ollama Cloud models from the live hosted catalog. Commonly
available hosted ids include:

- `ollama-cloud/gpt-oss:20b`
- `ollama-cloud/kimi-k2.6`
- `ollama-cloud/deepseek-v4-flash`
- `ollama-cloud/minimax-m2.7`
- `ollama-cloud/glm-5`

Use a model id from your current hosted catalog:

```bash
openclaw models list --provider ollama-cloud
openclaw models set ollama-cloud/kimi-k2.6
```

Model ids are cloud catalog ids, not local pull names. If a model name works in
a local Ollama host but is absent from the hosted catalog, use the `ollama`
provider with that local host instead.

## Live test

For Ollama Cloud API-key smoke tests, point the Ollama live test at the hosted
endpoint and choose a model from your current catalog:

```bash
export OLLAMA_API_KEY="<your-ollama-cloud-api-key>" # pragma: allowlist secret

OPENCLAW_LIVE_TEST=1 \
OPENCLAW_LIVE_OLLAMA=1 \
OPENCLAW_LIVE_OLLAMA_BASE_URL=https://ollama.com \
OPENCLAW_LIVE_OLLAMA_MODEL=kimi-k2.6 \
OPENCLAW_LIVE_OLLAMA_WEB_SEARCH=1 \
pnpm test:live -- extensions/ollama/ollama.live.test.ts
```

The cloud smoke runs text, native stream, and web search. It skips embeddings by
default for `https://ollama.com` because Ollama Cloud API keys may not authorize
`/api/embed`.

## Troubleshooting

- `Set OLLAMA_API_KEY` errors: provide a real cloud API key. The local
  `ollama-local` marker is only for local or private Ollama hosts.
- Unknown model errors: run `openclaw models list --provider ollama-cloud` and
  copy the hosted model id exactly.
- Tool-call or raw JSON issues on custom Ollama hosts: check whether you are
  accidentally using an OpenAI-compatible `/v1` URL. Ollama routes should use
  the native base URL with no `/v1` suffix.

## Related

- [Ollama](/providers/ollama)
- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
