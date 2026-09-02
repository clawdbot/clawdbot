---
summary: "Pay per call for many models through a local openzoo proxy, no account or API key"
title: "openzoo"
read_when:
  - You want to use many LLMs without creating an account or managing API keys
  - You want to pay for inference per call over x402 from a local wallet
  - You want to run models via openzoo in OpenClaw
---

openzoo is a local proxy that pays for LLM inference per call over x402 (on-chain
micropayments from a local burner wallet). There is no account and no API key: you run the
proxy, fund its wallet, and point OpenClaw at `http://localhost:8402/v1`.

| Property | Value                                                |
| -------- | ---------------------------------------------------- |
| Provider | `openzoo`                                            |
| Auth     | none (the proxy pays per call; keys are not checked) |
| API      | OpenAI-compatible                                    |
| Base URL | `http://localhost:8402/v1` (local proxy)             |

The public gateway at `https://x402-tokens.fly.dev/v1` answers HTTP 402 to unpaid calls. Only
the local proxy can pay, so OpenClaw always talks to the proxy, never to the gateway directly.

## Install plugin

```bash
openclaw plugins install @openclaw/openzoo-provider
openclaw gateway restart
```

## Setup

<Steps>
  <Step title="Start the proxy">
    In another terminal:

    ```bash
    npx openzoo
    ```

    Or install it once with `npm i -g openzoo` and run `openzoo`. The first run creates a
    burner wallet, prints its funding address, and listens on `http://localhost:8402/v1`.
    Fund the address with USDC on Solana or Base. Override the port with `OPENZOO_PORT`.

    OpenClaw does not start the proxy for you; it only detects a running one.

  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice openzoo
    ```

    Setup probes `GET http://localhost:8402/v1/info` (served by the proxy itself, no
    upstream call). If the proxy is not running, OpenClaw prints the `npx openzoo` hint and
    lets you retry.

    Non-interactive:

    ```bash
    openclaw onboard --non-interactive --accept-risk --skip-health --auth-choice openzoo
    ```

    Add `--custom-base-url http://host:8402/v1` for a proxy on another host and
    `--custom-model-id anthropic/claude-sonnet-5` to pick a default other than `auto`.

  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider openzoo
    ```
  </Step>
</Steps>

## Default model and catalog

The default model is `openzoo/auto`, the gateway's own router row. Routing behind `auto` is
owned by openzoo.

While the proxy is running, OpenClaw queries `GET http://localhost:8402/v1/models` (free, no
payment) and merges the discovered models ahead of a static fallback catalog. The static
fallback contains only `openzoo/auto` (`input: ["text"]`, `reasoning: false`,
`contextWindow: 128000000`, `maxTokens: 8192`, `cost: { input: 0.1, output: 0.2 }` USD per
million tokens). When the proxy is not running and `models.providers.openzoo` is not
configured, the provider is not listed at all.

Any model on the gateway is addressable as `openzoo/<upstream-id>` (for example
`openzoo/anthropic/claude-sonnet-5`, `openzoo/x-ai/grok-4.6`). Media rows (image and video
generation) and rows without a price are excluded from the chat catalog.

The discovered `context_length` is the client-usable window: the proxy spills long context
server-side, so OpenClaw keeps the advertised 128M-token window rather than the upstream
model's native limit.

## Pricing

Discovered prices are a ceiling. The gateway reports each model on an OpenRouter-direct basis
(USD per token, converted to USD per million tokens in OpenClaw) and charges at most that,
often far less through context reuse. The prices you see in `openclaw models list` are the
most you will pay per token for that model.

Payments settle on chain per call over x402. Receipts live in `~/.openzoo/proxy.log`.

## Config example

```json5
{
  models: {
    providers: {
      openzoo: {
        baseUrl: "http://localhost:8402/v1",
        api: "openai-completions",
        apiKey: "sk-openzoo", // any placeholder; the zoo takes payment, not keys
        models: [
          {
            id: "auto",
            name: "auto",
            reasoning: false,
            input: ["text"],
            cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "openzoo/auto" },
    },
  },
}
```

Omit `apiKey` and OpenClaw synthesizes a local non-secret marker for the provider; set a real
`apiKey` only when you front the proxy with your own authenticating reverse proxy. Explicit
`models` rows stay authoritative and live discovery fills in the rest of the catalog.

Set `OPENZOO_BASE_URL` (or `OPENZOO_PORT`) in the Gateway environment to point OpenClaw at a
proxy that is not on `http://localhost:8402/v1`; `models.providers.openzoo.baseUrl` wins over
both.

## Behavior notes

<AccordionGroup>
  <Accordion title="Transport and compatibility">
    The proxy forwards OpenAI-compatible bodies to OpenRouter-shaped upstreams, so OpenClaw
    uses the proxy-style OpenAI-compatible request path rather than native OpenAI request
    shaping.

    - Gemini-backed refs stay on the proxy-Gemini path: OpenClaw sanitizes Gemini thought
      signatures there but does not enable native Gemini replay validation.
    - Requests carry a Bearer token built from the placeholder key; the proxy ignores it on
      localhost.

  </Accordion>

  <Accordion title="Reasoning models">
    OpenClaw only marks a discovered model as reasoning-capable when its id says so
    unambiguously (`o1`, `o3`, `o4`, `r1`, `qwq`, `reasoner`, `thinking`). A wrong
    `reasoning: true` breaks requests; a wrong `false` only hides the thinking toggle. Add an
    explicit `models` row with `reasoning: true` to override.
  </Accordion>

  <Accordion title="Troubleshooting">
    - `openclaw models list --provider openzoo` shows only `openzoo/auto`: the proxy was not
      reachable at discovery time. Start `npx openzoo` and restart the Gateway.
    - The provider is missing entirely: the proxy is not running and nothing is configured
      under `models.providers.openzoo`. Run `openclaw onboard --auth-choice openzoo`.
    - Requests fail with HTTP 402: the burner wallet is empty. Fund the address the proxy
      printed at startup.
    - When the Gateway runs as a daemon, the proxy must be reachable from that process; use
      `OPENZOO_BASE_URL` or `models.providers.openzoo.baseUrl` for a non-default host.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full OpenClaw configuration reference.
  </Card>
  <Card title="openzoo" href="https://openzoo.fun" icon="arrow-up-right-from-square">
    openzoo site, proxy source, and funding instructions.
  </Card>
</CardGroup>
