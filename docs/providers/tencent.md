---
summary: "Tencent Cloud TokenHub setup for Hy3 preview"
title: "Tencent Cloud (TokenHub)"
read_when:
  - You want to use Tencent Hy3 preview with OpenClaw
  - You need the TokenHub API key setup
---

Tencent Cloud ships as a bundled provider plugin in OpenClaw. It gives access to Tencent Hy3 preview through the TokenHub endpoint (`tencent-tokenhub`) using an OpenAI-compatible API.

| Property         | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| Provider id      | `tencent-tokenhub`                                    |
| Plugin           | bundled, `enabledByDefault: true`                     |
| Auth env var     | `TOKENHUB_API_KEY`                                    |
| Onboarding flag  | `--auth-choice tokenhub-api-key`                      |
| Direct CLI flag  | `--tokenhub-api-key <key>`                            |
| API              | OpenAI-compatible (`openai-completions`)              |
| Default base URL | `https://tokenhub.tencentmaas.com/v1`                 |
| Global base URL  | `https://tokenhub-intl.tencentmaas.com/v1` (override) |
| Default model    | `tencent-tokenhub/hy3-preview`                        |

## Quick start

<Steps>
  <Step title="Create a TokenHub API key">
    Create an API key in Tencent Cloud TokenHub. If you choose a limited access scope for the key, include **Hy3 preview** in the allowed models.
  </Step>
  <Step title="Run onboarding">
    <CodeGroup>

```bash Onboarding
openclaw onboard --auth-choice tokenhub-api-key
```

```bash Direct flag
openclaw onboard --non-interactive \
  --auth-choice tokenhub-api-key \
  --tokenhub-api-key "$TOKENHUB_API_KEY"
```

```bash Env only
export TOKENHUB_API_KEY=...
```

    </CodeGroup>

  </Step>
  <Step title="Verify the model">
    ```bash
    openclaw models list --provider tencent-tokenhub
    ```
  </Step>
</Steps>

## Non-interactive setup

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice tokenhub-api-key \
  --tokenhub-api-key "$TOKENHUB_API_KEY" \
  --skip-health \
  --accept-risk
```

## Built-in catalog

| Model ref                      | Name                   | Input | Context | Max output | Notes                      |
| ------------------------------ | ---------------------- | ----- | ------- | ---------- | -------------------------- |
| `tencent-tokenhub/hy3-preview` | Hy3 preview (TokenHub) | text  | 256,000 | 64,000     | Default; reasoning-enabled |

Hy3 preview is Tencent Hunyuan's large MoE language model for reasoning, long-context instruction following, code, and agent workflows. Tencent's OpenAI-compatible examples use `hy3-preview` as the model id and support standard chat-completions tool calling plus `reasoning_effort`.

<Tip>
  The model id is `hy3-preview`. Do not confuse it with Tencent's `HY-3D-*` models, which are 3D generation APIs and are not the OpenClaw chat model configured by this provider.
</Tip>

## Tiered pricing

The bundled catalog ships tiered cost metadata that scales with input window length, so cost estimates are populated without manual overrides.

| Input tokens range | Input rate | Output rate | Cache read |
| ------------------ | ---------- | ----------- | ---------- |
| 0 - 16,000         | 0.176      | 0.587       | 0.059      |
| 16,000 - 32,000    | 0.235      | 0.939       | 0.088      |
| 32,000+            | 0.293      | 1.173       | 0.117      |

Rates are per million tokens in USD as advertised by Tencent. Override pricing under `models.providers.tencent-tokenhub` only when you need a different surface.

## Advanced configuration

<AccordionGroup>
  <Accordion title="Endpoint override">
    OpenClaw defaults to Tencent Cloud's `https://tokenhub.tencentmaas.com/v1` endpoint. Tencent also documents an international TokenHub endpoint:

    ```bash
    openclaw config set models.providers.tencent-tokenhub.baseUrl "https://tokenhub-intl.tencentmaas.com/v1"
    ```

    Only override the endpoint when your TokenHub account or region requires it.

  </Accordion>

  <Accordion title="Environment availability for the daemon">
    If the Gateway runs as a managed service (launchd, systemd, Docker), `TOKENHUB_API_KEY` must be visible to that process. Set it in `~/.openclaw/.env` or via `env.shellEnv` so launchd, systemd, or Docker exec environments can read it.

    <Warning>
      Keys set only in `~/.profile` are not visible to managed gateway processes. Use the env file or config seam for persistent availability.
    </Warning>

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration" icon="gear">
    Full config schema including provider settings.
  </Card>
  <Card title="Tencent TokenHub" href="https://cloud.tencent.com/product/tokenhub" icon="arrow-up-right-from-square">
    Tencent Cloud's TokenHub product page.
  </Card>
  <Card title="Hy3 preview model card" href="https://huggingface.co/tencent/Hy3-preview" icon="square-poll-horizontal">
    Tencent Hunyuan Hy3 preview details and benchmarks.
  </Card>
</CardGroup>
