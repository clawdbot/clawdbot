# OpenClaw LLMTR provider

Official OpenClaw provider plugin for LLMTR, an OpenAI-compatible AI gateway
that serves global vendor models alongside Turkey-hosted models behind one API
key.

## Install

```sh
openclaw plugins install @openclaw/llmtr-provider
openclaw gateway restart
```

Configure `LLMTR_API_KEY`, then select a model such as
`llmtr/anthropic/claude-sonnet-5` or `llmtr/trendyol-asure-12b`.

## Docs

See `docs/providers/llmtr.md` in the OpenClaw repository, or the published docs
at `https://docs.openclaw.ai/providers/llmtr`.
