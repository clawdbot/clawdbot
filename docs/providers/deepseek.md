---
summary: "DeepSeek setup (auth + model selection)"
title: "DeepSeek"
read_when:
  - You want to use DeepSeek with OpenClaw
  - You need the API key env var or CLI auth choice
---

[DeepSeek](https://www.deepseek.com) provides powerful AI models with an OpenAI-compatible API.

| Property | Value                      |
| -------- | -------------------------- |
| Provider | `deepseek`                 |
| Auth     | `DEEPSEEK_API_KEY`         |
| API      | OpenAI-compatible          |
| Base URL | `https://api.deepseek.com` |

## Install plugin

Install the official plugin, then restart Gateway:

```bash
openclaw plugins install @openclaw/deepseek-provider
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key at [platform.deepseek.com](https://platform.deepseek.com/api_keys).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice deepseek-api-key
    ```

    Prompts for your API key and sets `deepseek/deepseek-v4-flash` as the default model.

  </Step>
  <Step title="Verify models are available">
    ```bash
    openclaw models list --provider deepseek
    ```

    To inspect the plugin's static catalog without a running Gateway:

    ```bash
    openclaw models list --all --provider deepseek
    ```

  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Non-interactive setup">
    For scripted or headless installations, pass all flags directly:

    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice deepseek-api-key \
      --deepseek-api-key "$DEEPSEEK_API_KEY" \
      --skip-health \
      --accept-risk
    ```

  </Accordion>
</AccordionGroup>

<Warning>
If Gateway runs as a daemon (launchd/systemd), make sure `DEEPSEEK_API_KEY` is
available to that process (for example, in `~/.openclaw/.env` or via
`env.shellEnv`).
</Warning>

## Built-in catalog

| Model ref                    | Name              | Input | Context   | Max output | Notes                                               |
| ---------------------------- | ----------------- | ----- | --------- | ---------- | --------------------------------------------------- |
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash | text  | 1,000,000 | 384,000    | Default model; V4 thinking-capable surface          |
| `deepseek/deepseek-v4-pro`   | DeepSeek V4 Pro   | text  | 1,000,000 | 384,000    | V4 thinking-capable surface                         |
| `deepseek/deepseek-chat`     | DeepSeek Chat     | text  | 1,000,000 | 384,000    | Deprecated V4 Flash non-thinking compatibility name |
| `deepseek/deepseek-reasoner` | DeepSeek Reasoner | text  | 1,000,000 | 384,000    | Deprecated V4 Flash thinking compatibility name     |

<Warning>
DeepSeek will retire `deepseek-chat` and `deepseek-reasoner` on July 24, 2026
at 15:59 UTC. They currently route to DeepSeek V4 Flash in non-thinking and
thinking mode, respectively. Move configured model refs to
`deepseek/deepseek-v4-flash` or `deepseek/deepseek-v4-pro` before the cutoff.
</Warning>

OpenClaw's local cost estimates follow DeepSeek's published cache-hit,
cache-miss, and output rates. DeepSeek can change those rates; its
[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) page is
authoritative for billing.

<Tip>
V4 models support DeepSeek's `thinking` control. OpenClaw also replays
DeepSeek `reasoning_content` on follow-up turns so thinking sessions with tool
calls can continue.
Use `/think xhigh` or `/think max` with DeepSeek V4 models to request DeepSeek's
maximum `reasoning_effort`; both map to `"max"`.
</Tip>

## Thinking and tools

DeepSeek V4 thinking sessions require replayed assistant messages from a
thinking-enabled turn to include `reasoning_content` on follow-up requests.
OpenClaw's DeepSeek plugin backfills that field automatically, so normal
multi-turn tool use works on `deepseek/deepseek-v4-flash` and
`deepseek/deepseek-v4-pro` even when history came from another
OpenAI-compatible provider (no native `reasoning_content`) or from a plain
assistant message. No `/new` required after switching providers mid-session.

When thinking is disabled (including the UI **None** selection), OpenClaw
sends `thinking: { type: "disabled" }` and strips replayed `reasoning_content`
from outgoing history, keeping the session on the non-thinking DeepSeek path.

Use `deepseek/deepseek-v4-flash` for the default fast path. Use
`deepseek/deepseek-v4-pro` for the stronger model when you can accept higher
cost or latency.

## Live testing

To run only the DeepSeek V4 direct-model checks from the modern model live suite:

```bash
OPENCLAW_LIVE_PROVIDERS=deepseek \
OPENCLAW_LIVE_MODELS="deepseek/deepseek-v4-flash,deepseek/deepseek-v4-pro" \
pnpm test:live src/agents/models.profiles.live.test.ts
```

Verifies both V4 models complete and that thinking/tool follow-up turns
preserve the replay payload DeepSeek requires.

## Config example

```json5
{
  env: { DEEPSEEK_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "deepseek/deepseek-v4-flash" },
    },
  },
}
```

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config reference for agents, models, and providers.
  </Card>
</CardGroup>
