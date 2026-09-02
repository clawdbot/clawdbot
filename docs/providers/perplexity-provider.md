---
summary: "Perplexity web search provider setup (API key, search modes, filtering)"
title: "Perplexity"
read_when:
  - You want to configure Perplexity as a web search provider
  - You need the Perplexity API key or OpenRouter proxy setup
---

The Perplexity plugin registers a `web_search` provider with two transports: the
native Perplexity Search API (structured results with filters) and Perplexity
Sonar chat completions, direct or via OpenRouter (AI-synthesized answers with
citations).

<Note>
This page covers the Perplexity **provider** setup. For the Perplexity **tool** (how the agent uses it), see [Perplexity search](/tools/perplexity-search).
</Note>

| Property    | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Type        | Web search provider (not a model provider)                             |
| Auth        | `PERPLEXITY_API_KEY` (native) or `OPENROUTER_API_KEY` (via OpenRouter) |
| Config path | `plugins.entries.perplexity.config.webSearch.apiKey`                   |
| Overrides   | `plugins.entries.perplexity.config.webSearch.baseUrl` / `.model`       |
| Get a key   | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api)   |

## Install plugin

```bash
openclaw plugins install @openclaw/perplexity-plugin
openclaw gateway restart
```

## Getting started

<Steps>
  <Step title="Set the API key">
    ```bash
    openclaw configure --section web
    ```

    Or set the key directly:

    ```bash
    openclaw config set plugins.entries.perplexity.config.webSearch.apiKey "pplx-xxxxxxxxxxxx"
    ```

    A key exported as `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY` in the Gateway
    environment also works.

  </Step>
  <Step title="Start searching">
    `web_search` auto-detects Perplexity once its key is the available search
    credential; no further setup is required. To pin the provider explicitly:

    ```bash
    openclaw config set tools.web.search.provider perplexity
    ```

  </Step>
</Steps>

## Search modes

The plugin resolves transport in this order:

1. `webSearch.baseUrl` or `webSearch.model` set: always routes through Sonar chat completions against that endpoint, regardless of key type.
2. Otherwise, key source decides the endpoint: a configured key's prefix picks the transport (config beats environment variables); an environment key uses its matching endpoint directly.

| Key prefix | Transport                                                  | Features                                         |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `pplx-`    | Native Perplexity Search API (`https://api.perplexity.ai`) | Structured results, domain/language/date filters |
| `sk-or-`   | OpenRouter (`https://openrouter.ai/api/v1`), Sonar model   | AI-synthesized answers with citations            |

A configured key with any other prefix also uses the native Search API. The
chat-completions path defaults to the `perplexity/sonar-pro` model; override it
with `plugins.entries.perplexity.config.webSearch.model`.

## Native API filtering

| Filter                               | Description                                                     | Transport   |
| ------------------------------------ | --------------------------------------------------------------- | ----------- |
| `count`                              | Results per search, 1-10 (default 5)                            | Native only |
| `freshness`                          | Recency window: `day`, `week`, `month`, `year`                  | Both        |
| `country`                            | 2-letter country code (`us`, `de`, `jp`)                        | Native only |
| `language`                           | ISO 639-1 language code (`en`, `fr`, `zh`)                      | Native only |
| `date_after` / `date_before`         | Published-date range in `YYYY-MM-DD`                            | Native only |
| `domain_filter`                      | Max 20 domains; allowlist or `-`-prefixed denylist, never mixed | Native only |
| `max_tokens` / `max_tokens_per_page` | Content budget across all results / per page                    | Native only |

Native-only filters return a descriptive error on the chat-completions path.
`freshness` cannot be combined with `date_after`/`date_before`.

## Advanced configuration

<AccordionGroup>
  <Accordion title="Environment variable for daemon processes">
    <Warning>
    A key exported only in an interactive shell is not visible to a
    launchd/systemd Gateway daemon unless that environment is explicitly
    imported. Set the key in `~/.openclaw/.env` or via `env.shellEnv` so the
    Gateway process can read it. See [Environment variables](/help/environment)
    for the full precedence order.
    </Warning>
  </Accordion>

  <Accordion title="OpenRouter proxy setup">
    To route Perplexity searches through OpenRouter, set an `OPENROUTER_API_KEY`
    (prefix `sk-or-`) instead of a native Perplexity key. OpenClaw detects the
    key and switches to the Sonar transport automatically. Useful if you already
    have OpenRouter billing set up and want to consolidate providers there.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Perplexity search tool" href="/tools/perplexity-search" icon="magnifying-glass">
    How the agent invokes Perplexity searches and interprets results.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full configuration reference including plugin entries.
  </Card>
</CardGroup>
