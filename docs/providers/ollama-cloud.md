---
summary: "Use Ollama Cloud directly with OpenClaw"
read_when:
  - You want to use hosted Ollama models without a local Ollama server
  - You need the ollama-cloud provider id, key, or endpoint
title: "Ollama Cloud"
---

Ollama Cloud is Ollama's hosted model API. The `ollama-cloud` provider calls it
directly at `https://ollama.com` over Ollama's native `/api/chat` API, with no
local Ollama server and no local Ollama app signed into cloud mode. Use model
refs like `ollama-cloud/kimi-k2.6`.

OpenClaw registers `ollama-cloud` as its own provider id so cloud-only
credentials, live catalog discovery, and model selection do not get mixed with
a local `ollama` host. For local Ollama, hybrid cloud-plus-local routing,
embeddings, and custom host details, see [Ollama](/providers/ollama).

## Setup

Create an Ollama Cloud API key at [ollama.com/settings/keys](https://ollama.com/settings/keys), then run:

```bash
openclaw onboard --auth-choice ollama-cloud
```

Or set:

```bash
export OLLAMA_API_KEY="<your-ollama-cloud-api-key>" # pragma: allowlist secret
```

Non-interactive onboarding accepts the key directly:

```bash
openclaw onboard --auth-choice ollama-cloud --ollama-cloud-api-key "<key>"
```

Onboarding sets the default model to `ollama-cloud/kimi-k2.5:cloud`.

## Defaults

- Provider: `ollama-cloud`
- Base URL: `https://ollama.com`
- Env var: `OLLAMA_API_KEY`
- API style: Ollama native `/api/chat`
- Onboarding default model: `ollama-cloud/kimi-k2.5:cloud`

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

The provider requires an API key; without one it stays inactive. With a key,
OpenClaw discovers Ollama Cloud models live from the hosted catalog:

```bash
openclaw models list --provider ollama-cloud
openclaw models set ollama-cloud/kimi-k2.6
```

Hosted ids in the live catalog include `deepseek-v4-flash`, `glm-5`,
`gpt-oss:20b`, `kimi-k2.6`, and `minimax-m2.7`. When live discovery returns
nothing, OpenClaw falls back to the bundled rows `kimi-k2.5:cloud`,
`minimax-m2.7:cloud`, `glm-5.1:cloud`, and `glm-5.2:cloud`.

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
pnpm test:live -- extensions/ollama/ollama.live.test.ts
```

The cloud smoke runs text, native stream, and web search; set
`OPENCLAW_LIVE_OLLAMA_WEB_SEARCH=0` to skip web search. It skips embeddings by
default for `https://ollama.com` because Ollama Cloud API keys may not
authorize `/api/embed`; force them with `OPENCLAW_LIVE_OLLAMA_EMBEDDINGS=1`.

## Troubleshooting

- `Ollama Cloud requires an API key` / `Set OLLAMA_API_KEY` errors: provide a
  real cloud API key. The local `ollama-local` marker is only for local or
  private Ollama hosts.
- Unknown model errors: run `openclaw models list --provider ollama-cloud` and
  copy the hosted model id exactly.
- Tool-call or raw JSON issues on custom Ollama hosts: check whether you are
  accidentally using an OpenAI-compatible `/v1` URL. Ollama routes should use
  the native base URL with no `/v1` suffix.

## Related

- [Ollama](/providers/ollama)
- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
