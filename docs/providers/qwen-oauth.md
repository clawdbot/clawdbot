---
summary: "Use the Qwen Portal provider id with OpenClaw"
read_when:
  - You want to configure the qwen-oauth provider id
  - You previously used Qwen Portal OAuth credentials
  - You need the Qwen Portal endpoint or migration guidance
title: "Qwen OAuth / Portal"
---

`qwen-oauth` is the Qwen Portal provider id. It targets the Qwen Portal endpoint
and keeps older Qwen OAuth / portal setups addressable through a distinct
provider id.

Use this provider when you specifically have a current Qwen Portal token for
`https://portal.qwen.ai/v1`, or when you are migrating an older Qwen Portal /
Qwen CLI setup and want to keep those credentials separate from the canonical
Qwen Cloud provider. It is not the recommended first choice for new Qwen users.

For new Qwen Cloud setups, prefer [Qwen](/providers/qwen) with the Standard
ModelStudio endpoint unless you specifically have a current Qwen Portal token.

## Setup

Provide your portal token through onboarding:

```bash
openclaw onboard --auth-choice qwen-oauth
```

Or set:

```bash
export QWEN_API_KEY="<your-qwen-portal-token>" # pragma: allowlist secret
```

## Defaults

- Provider: `qwen-oauth`
- Aliases: `qwen-portal`, `qwen-cli`
- Base URL: `https://portal.qwen.ai/v1`
- Env var: `QWEN_API_KEY`
- API style: OpenAI-compatible
- Default model: `qwen-oauth/qwen3.5-plus`

## How this differs from Qwen

OpenClaw has two Qwen-facing provider ids:

| Provider     | Endpoint family                                          | Best for                                                                               |
| ------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `qwen`       | Qwen Cloud / Alibaba DashScope and Coding Plan endpoints | New API-key setups, Standard pay-as-you-go, Coding Plan, multimodal DashScope features |
| `qwen-oauth` | Qwen Portal endpoint at `portal.qwen.ai/v1`              | Existing Qwen Portal tokens and legacy Qwen OAuth / CLI setups                         |

Both providers use OpenAI-compatible request shapes, but they are separate auth
surfaces. A token stored for `qwen-oauth` should not be treated as a DashScope
or ModelStudio key, and a new DashScope key should use the canonical `qwen`
provider instead.

## When to choose Qwen OAuth / Portal

- You already have a working Qwen Portal token.
- You are preserving a legacy Qwen OAuth or Qwen CLI workflow while moving to
  OpenClaw's provider model.
- You need to test compatibility with the Qwen Portal endpoint specifically.

Choose [Qwen](/providers/qwen) for new setup, broader endpoint choices, Standard
ModelStudio, Coding Plan, and the full bundled Qwen catalog.

## Models

The bundled catalog seeds the Qwen Portal default:

- `qwen-oauth/qwen3.5-plus`

Availability depends on the current Qwen Portal account and token. If your
account uses ModelStudio / DashScope API keys instead, configure the canonical
`qwen` provider:

```bash
openclaw onboard --auth-choice qwen-standard-api-key
openclaw models set qwen/qwen3-coder-plus
```

## Migration

Legacy Qwen Portal OAuth profiles may not be refreshable. If a portal profile
stops working, re-authenticate with a current token or switch to the Standard
Qwen provider:

```bash
openclaw onboard --auth-choice qwen-standard-api-key
```

Standard global ModelStudio uses:

```text
https://dashscope-intl.aliyuncs.com/compatible-mode/v1
```

## Troubleshooting

- Portal OAuth refresh failures: legacy Qwen Portal OAuth profiles may not be
  refreshable. Re-run onboarding with a current token.
- Wrong endpoint errors: confirm the model ref starts with `qwen-oauth/` when
  using a portal token. Use `qwen/` refs only for the canonical Qwen provider.
- `QWEN_API_KEY` confusion: both Qwen pages mention this env var, but onboarding
  stores credentials under the selected provider id. Prefer onboarding when you
  keep both `qwen` and `qwen-oauth` available on the same machine.

## Related

- [Qwen](/providers/qwen)
- [Alibaba Model Studio](/providers/alibaba)
- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
