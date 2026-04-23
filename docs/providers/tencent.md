---
title: "Tencent Cloud (TokenHub)"
summary: "Tencent Cloud TokenHub setup"
read_when:
  - You want to use Tencent Hy models with OpenClaw
  - You need the TokenHub API key setup
---

# Tencent Cloud (TokenHub)

Tencent Cloud ships as a **bundled provider plugin** in OpenClaw. It gives access to Tencent Hy models via the TokenHub endpoint (`tencent-tokenhub`).

The provider uses an OpenAI-compatible API.

## Quick start

```bash
openclaw onboard --auth-choice tokenhub-api-key
```

## Non-interactive example

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice tokenhub-api-key \
  --tokenhub-api-key "$TOKENHUB_API_KEY" \
  --skip-health \
  --accept-risk
```

## Providers and endpoints

| Provider           | Endpoint                      | Use case                |
| ------------------ | ----------------------------- | ----------------------- |
| `tencent-tokenhub` | `tokenhub.tencentmaas.com/v1` | Hy via Tencent TokenHub |

## Available models

### tencent-tokenhub

- **hy3-preview** — Hy3 preview (256K context, reasoning, default)

## Notes

- TokenHub model refs use `tencent-tokenhub/<modelId>`.
- The plugin ships with tiered Hy3 pricing metadata built in, so cost estimates are populated without manual pricing overrides.
- Override pricing and context metadata in `models.providers` if needed.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `TOKENHUB_API_KEY`
is available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).

## Related documentation

- [OpenClaw Configuration](/gateway/configuration)
- [Model Providers](/concepts/model-providers)
- [Tencent TokenHub](https://cloud.tencent.com/document/product/1823/130050)
