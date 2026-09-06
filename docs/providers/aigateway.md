---
summary: "Use AIgateway's OpenAI-compatible aggregator endpoint with OpenClaw"
read_when:
  - You want to run OpenClaw with AIgateway models
  - You need the AIgateway provider id, key, or endpoint
title: "AIgateway"
---

AIgateway is a model aggregator: one OpenAI-compatible endpoint, one API key,
1,000+ models from 85+ labs — text, image, video, audio, and embeddings — at
pass-through provider pricing. OpenClaw provides AIgateway through the bundled
`@openclaw/aigateway-provider` plugin. Model refs use the
`aigateway/zai-org/glm-5.3-flash` form.

## Setup

Install the plugin and restart the Gateway:

```bash
openclaw plugins install @openclaw/aigateway-provider
openclaw gateway restart
```

Create an API key at
[aigateway.sh/dashboard/keys](https://aigateway.sh/dashboard/keys), then run:

```bash
openclaw onboard --auth-choice aigateway-api-key
```

Or set:

```bash
export AIGATEWAY_API_KEY=sk-aig-...
```

## Models

Model IDs are `provider/slug` pairs — `anthropic/claude-opus-4.7`,
`openai/gpt-5.4`, `zai-org/glm-5.3-flash`, `moonshot/kimi-k2.7-code`. The
bundled catalog ships a curated set; the full 1,000+ model catalog is at
[aigateway.sh/models](https://aigateway.sh/models) and is discoverable at
runtime through the provider's `/v1/models` endpoint.

## Notes

- Billing is pass-through provider pricing plus a flat 5% on credit top-ups;
  nothing per request.
- Reasoning is controlled through OpenAI Chat Completions `reasoning_effort`
  (plus the `enable_thinking` convenience boolean); per-model surfaces vary.
- Docs: [aigateway.sh/docs](https://aigateway.sh/docs)
