---
summary: "Use Perplexity's Agent API as a custom LLM provider in OpenClaw (Claude, GPT, Gemini, Grok via one key)"
title: "Perplexity Agent API"
read_when:
  - You want to run Anthropic, OpenAI, Google, or xAI models through Perplexity's Agent API as an OpenClaw model provider
  - You want to connect Perplexity's Model Context Protocol server to OpenClaw
  - You need the required OpenClaw configuration for Perplexity's Agent API
---

Perplexity's [Agent API](https://docs.perplexity.ai/docs/agent-api/quickstart) exposes frontier models from Anthropic, OpenAI, Google, xAI, and others through a single OpenAI-Responses-compatible endpoint. OpenClaw can consume Perplexity three ways: as a model provider, as an MCP tool provider, and as a terminal companion for shell and script use.

<Note>
This page covers Perplexity as a **model provider** and as an **MCP server**. For Perplexity as OpenClaw's **web search provider** (managed by the `@openclaw/perplexity-plugin` package), see [Perplexity](/providers/perplexity-provider).
</Note>

| Property     | Value                                                                    |
| ------------ | ------------------------------------------------------------------------ |
| Type         | Model provider (custom OpenAI-Responses backend)                         |
| API          | `openai-responses`                                                       |
| Base URL     | `https://api.perplexity.ai/v1`                                           |
| Auth         | `PERPLEXITY_API_KEY` (Perplexity API key, prefix `pplx-`)                |
| Get a key    | [console.perplexity.ai](https://console.perplexity.ai/project/keys)      |
| Provider ID  | `perplexity` (recommended; passed via `--custom-provider-id`)            |

## Required configuration

Perplexity's Agent API runs its own server-side built-in tools. To use it as an OpenClaw model provider, disable OpenClaw's managed `web_search` tool so the model uses Perplexity's built-in search instead:

```json5
{
  tools: {
    web: {
      search: { enabled: false },
    },
  },
}
```

<Warning>
`tools.web.search.enabled: false` is a Gateway-wide setting. It disables the managed `web_search` tool for every agent on this Gateway, not just for the agent using Perplexity's Agent API. If other agents on the same Gateway rely on managed `web_search`, scope the disable per-agent with `agents.entries.<name>.tools.deny: ["web_search"]` on the Perplexity agent instead, or run Perplexity's Agent API on a separate Gateway profile.
</Warning>

Perplexity's server-side `web_search` runs from inside the model's response at $0.0025 per call and returns grounded results with citations.

### Reserved tool names

Perplexity's Agent API reserves these function names for its own server-side built-in tools; do not define custom functions with these names:

- `web_search`
- `fetch_url`
- `people_search`
- `finance_search`

See Perplexity's [OpenClaw integration guide](https://docs.perplexity.ai/docs/getting-started/integrations/openclaw) for the authoritative reference.

## Getting started

<Steps>
  <Step title="Get an API key">
    Create a key in the [Perplexity API console](https://console.perplexity.ai/project/keys). Keys start with `pplx-`.
  </Step>
  <Step title="Persist the credential for the Gateway service">
    Set the Perplexity key in your current shell, then choose the path that matches your existing custom-provider setup.

    **No existing custom provider uses `CUSTOM_API_KEY`:** add the key under the custom-provider variable name in the state-directory `.env` before installing the daemon:

    ```bash
    export PERPLEXITY_API_KEY="pplx-..."
    state_dir="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    umask 077
    mkdir -p "$state_dir"
    printf 'CUSTOM_API_KEY=%s\n' "$PERPLEXITY_API_KEY" >> "$state_dir/.env"
    chmod 600 "$state_dir/.env"
    export CUSTOM_API_KEY="$PERPLEXITY_API_KEY"
    ```

    Use this path only when `CUSTOM_API_KEY` is not already assigned in your shell or state-directory `.env`. If it is already present, do not replace it: non-interactive custom-provider onboarding uses that same variable for every custom provider.

    **An existing custom provider already uses `CUSTOM_API_KEY`:** preserve that value and add or update a separate `PERPLEXITY_API_KEY` line in the state-directory `.env`:

    ```bash
    export PERPLEXITY_API_KEY="pplx-..."
    state_dir="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
    umask 077
    mkdir -p "$state_dir"
    printf 'PERPLEXITY_API_KEY=%s\n' "$PERPLEXITY_API_KEY" >> "$state_dir/.env"
    chmod 600 "$state_dir/.env"
    ```

    The state-directory `.env` is a trusted, durable environment source for installed Gateway services; a shell export alone disappears when that shell exits. See [Environment variables](/help/environment) for the full loading and precedence rules.
  </Step>
  <Step title="Run onboarding">
    If `CUSTOM_API_KEY` was unused and you chose the first credential path above, run:

    ```bash
    openclaw onboard \
      --non-interactive \
      --accept-risk \
      --auth-choice custom-api-key \
      --secret-input-mode ref \
      --custom-base-url "https://api.perplexity.ai/v1" \
      --custom-model-id "anthropic/claude-sonnet-4-6" \
      --custom-compatibility openai-responses \
      --custom-provider-id perplexity \
      --install-daemon
    ```

    If another custom provider already uses `CUSTOM_API_KEY`, keep that shared value unchanged. Mask it only for the onboarding process, write a provider-specific SecretRef for Perplexity, and install the daemon after the reference is in place:

    ```bash
    CUSTOM_API_KEY= openclaw onboard \
      --non-interactive \
      --accept-risk \
      --auth-choice custom-api-key \
      --secret-input-mode ref \
      --custom-base-url "https://api.perplexity.ai/v1" \
      --custom-model-id "anthropic/claude-sonnet-4-6" \
      --custom-compatibility openai-responses \
      --custom-provider-id perplexity

    openclaw config set models.providers.perplexity.apiKey \
      --ref-source env \
      --ref-provider default \
      --ref-id PERPLEXITY_API_KEY

    openclaw gateway install
    ```

    If your environment SecretRef provider alias is not `default`, pass that alias to `--ref-provider` instead. Prefixing only the onboarding command with `CUSTOM_API_KEY=` prevents the CLI from binding Perplexity to the existing shared credential; it does not change the shell or state-directory value.

    `--non-interactive` tells OpenClaw to skip the setup wizard and consume the flags directly. `--accept-risk` is required alongside it to acknowledge that agents have full system access. If you omit `--non-interactive`, OpenClaw can enter interactive setup, where the custom-provider values above are not applied. If you keep `--non-interactive` but omit `--accept-risk`, OpenClaw exits with an explicit risk-acknowledgment error before dispatching setup.

    `--secret-input-mode ref` tells OpenClaw to write an environment reference to `openclaw.json` instead of the literal key. On a default secrets setup, the first path persists `apiKey: { source: "env", provider: "default", id: "CUSTOM_API_KEY" }`; when an environment SecretRef provider alias is configured, `provider` contains that resolved alias instead. The daemon reads the referenced variable from its runtime environment on each request. The existing-custom-provider path replaces the onboarding result with the complete, provider-specific `{ source: "env", provider: "<env-provider-alias>", id: "PERPLEXITY_API_KEY" }` reference before installing the daemon; the command above uses the built-in `default` alias.

    `--custom-compatibility openai-responses` is required. Perplexity's Agent API primary endpoint is `POST /v1/agent`; it also accepts requests at `POST /v1/responses` as an OpenAI-Responses-compatible alias, which is what OpenClaw uses in this mode. It does not implement `/v1/chat/completions`, so `openai-completions` will not work.
  </Step>
  <Step title="Apply the required configuration">
    Edit `openclaw.json` (run `openclaw config file` to locate it) and add:

    ```json5
    {
      tools: {
        web: {
          search: { enabled: false },
        },
      },
    }
    ```

    See [Required configuration](#required-configuration) above for context and [Reserved tool names](#reserved-tool-names) for the full list.
  </Step>
  <Step title="Add the models you need">
    Onboarding wires up one model. To make additional Agent API models available, add explicit entries under `models.providers.perplexity.models[]`. `agents.defaults.models` is for aliases and per-model settings on already-registered models, not for registering new ones. See [Config example](#config-example) below for a working entry shape. The full model list, current pricing, and per-model context windows are published at [docs.perplexity.ai/docs/getting-started/models](https://docs.perplexity.ai/docs/getting-started/models).
  </Step>
</Steps>

## Config example

```json5
{
  agents: {
    defaults: {
      model: { primary: "perplexity/anthropic/claude-sonnet-4-6" },
    },
  },
  tools: {
    web: { search: { enabled: false } },
  },
  models: {
    mode: "merge",
    providers: {
      perplexity: {
        baseUrl: "https://api.perplexity.ai/v1",
        apiKey: {
          source: "env",
          provider: "default",
          id: "CUSTOM_API_KEY",
        },
        api: "openai-responses",
        models: [
          {
            id: "anthropic/claude-sonnet-4-6",
            name: "Claude Sonnet 4.6 (Perplexity)",
            api: "openai-responses",
            reasoning: false,
            input: ["text"],
            cost: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 16384,
          },
        ],
      },
    },
  },
}
```

Each `models[]` entry pins one Agent API model with explicit cost and window metadata. Add another entry for every model you want to route through this provider.

The example shows the SecretRef produced by the fresh custom-provider path. If `CUSTOM_API_KEY` already belongs to another provider, use the existing-custom-provider path above; the same field then references `PERPLEXITY_API_KEY` instead.

Model IDs under the provider block omit the provider prefix. The full model reference adds it: config ID `anthropic/claude-sonnet-4-6`, full ref `perplexity/anthropic/claude-sonnet-4-6`.

For the full list of available models and current pricing, see the [Agent API models page](https://docs.perplexity.ai/docs/agent-api/models).

## Perplexity as an MCP server

Perplexity also ships an [MCP server](https://docs.perplexity.ai/docs/getting-started/integrations/mcp-server) that exposes `perplexity_search`, `perplexity_ask`, `perplexity_research`, and `perplexity_reason` as MCP tools your agent can call. This is orthogonal to the model provider setup above: the Agent API drives the model, MCP gives the model access to Perplexity's search and research surfaces. You can run both together.

The MCP tool names do not overlap with Perplexity's Agent API reserved tool names, so no additional configuration is required.

To register the Perplexity MCP server, follow OpenClaw's standard [Connect MCP servers](/tools/mcp) guide and use the endpoint and credentials from the [Perplexity MCP server docs](https://docs.perplexity.ai/docs/getting-started/integrations/mcp-server). The generic guide covers both remote (Streamable HTTP) and local (stdio) transports, and its config patterns keep your API key out of `openclaw.json`.

## Perplexity CLI (terminal companion)

Perplexity also publishes a [terminal CLI](https://docs.perplexity.ai/docs/cli/overview) (`pplx`) that returns JSON from the Search API. It is a third integration path: not an LLM provider and not an MCP server, but useful when an OpenClaw agent needs to shell out for a web search, or when a developer wants to pipe Perplexity results into other shell tools.

Install the CLI by following the official instructions at [docs.perplexity.ai/docs/cli/overview](https://docs.perplexity.ai/docs/cli/overview), which cover versioned Homebrew, npm, and release-binary paths.

```bash
export PERPLEXITY_API_KEY=pplx-...
pplx search web "kubernetes pod OOMKilled causes" -n 5
pplx content snippets "how does a bloom filter decide set membership" \
  https://en.wikipedia.org/wiki/Bloom_filter
```

Because the CLI is invoked from a shell, agents running under OpenClaw's `exec` tool can call it directly. Nothing needs to change in `openclaw.json`.

## Configuration notes

<AccordionGroup>
  <Accordion title="API transport must be openai-responses">
    Set `api: "openai-responses"` at both the provider level and each model entry, or pass `--custom-compatibility openai-responses` during onboarding. Perplexity's Agent API primary endpoint is `POST /v1/agent`, and `POST /v1/responses` is its OpenAI-Responses-compatible alias; the `openai-responses` transport sends to that alias. The Agent API does not implement `/v1/chat/completions`, so `openai-completions` will not work.
  </Accordion>

  <Accordion title="Base URL must be exactly https://api.perplexity.ai/v1">
    Perplexity's Agent API primary endpoint is `POST /v1/agent`, and `POST /v1/responses` is its OpenAI-Responses-compatible alias. OpenClaw's `openai-responses` client sends to whatever base URL you give it with `/responses` appended, so the base URL must be `https://api.perplexity.ai/v1` for OpenClaw to hit the alias at `/v1/responses`.

    | Correct base URL | Do not use as a base URL |
    | ---------------- | ------------------------ |
    | `https://api.perplexity.ai/v1` | `https://api.perplexity.ai/v1/agent` (OpenClaw would call `/v1/agent/responses` and get `405 Method Not Allowed`) |
    | | `https://api.perplexity.ai/v1/responses` (OpenClaw would call `/v1/responses/responses` and get `404`) |
    | | `https://api.perplexity.ai` (missing `/v1`; requests hit `/responses` and get `404`) |
  </Accordion>

  <Accordion title="Model ID format">
    In the config, model IDs under a provider block omit the provider prefix. The full model reference adds it:

    - Config model ID: `anthropic/claude-sonnet-4-6`
    - Full model reference: `perplexity/anthropic/claude-sonnet-4-6`
  </Accordion>

</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Perplexity web search provider" href="/providers/perplexity-provider" icon="magnifying-glass">
    Perplexity as OpenClaw's `web_search` backend (separate from this model provider setup).
  </Card>
  <Card title="Connect MCP servers" href="/tools/mcp" icon="plug">
    Full field list and troubleshooting for `mcp.servers` entries.
  </Card>
  <Card title="Perplexity integration docs" href="https://docs.perplexity.ai/docs/getting-started/integrations/openclaw" icon="book">
    Perplexity's authoritative OpenClaw integration guide.
  </Card>
  <Card title="Perplexity MCP server" href="https://docs.perplexity.ai/docs/getting-started/integrations/mcp-server" icon="server">
    Remote and local MCP server setup and tool catalog.
  </Card>
  <Card title="Perplexity CLI" href="https://docs.perplexity.ai/docs/cli/overview" icon="terminal">
    Terminal companion for Perplexity search and page snippets.
  </Card>
  <Card title="Agent API models" href="https://docs.perplexity.ai/docs/agent-api/models" icon="list">
    Full Agent API model catalog and pricing.
  </Card>
</CardGroup>
