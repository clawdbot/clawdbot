---
summary: "Perplexity web search provider setup (API key, filters)"
title: "Perplexity"
read_when:
  - You want to configure Perplexity as a web search provider
  - You need the Perplexity API key setup
---

The Perplexity plugin registers a `web_search` provider backed by the Perplexity Search API, which returns structured results with `title`, `url`, and `snippet` fields.

<Note>
This page covers the Perplexity **web search provider**. For the Perplexity **tool** (how the agent uses it), see [Perplexity search](/tools/perplexity-search). To use Perplexity's **Agent API** as an LLM model provider (Claude, GPT, Gemini through one key), see [Perplexity Agent API](/providers/perplexity-agent-api).
</Note>

| Property    | Value                                                                |
| ----------- | -------------------------------------------------------------------- |
| Type        | Web search provider (not a model provider)                           |
| Auth        | `PERPLEXITY_API_KEY`                                                 |
| Config path | `plugins.entries.perplexity.config.webSearch.apiKey`                 |
| Get a key   | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) |

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

    A key exported as `PERPLEXITY_API_KEY` in the Gateway environment also works.

  </Step>
  <Step title="Start searching">
    `web_search` auto-detects Perplexity once its key is the available search
    credential; no further setup is required. To pin the provider explicitly:

    ```bash
    openclaw config set tools.web.search.provider perplexity
    ```

  </Step>
</Steps>

## Search API filtering

| Filter                               | Description                                                     | Transport   |
| ------------------------------------ | --------------------------------------------------------------- | ----------- |
| `count`                              | Results per search, 1-10 (default 5)                            | Native only |
| `freshness`                          | Recency window: `day`, `week`, `month`, `year`                  | Both        |
| `country`                            | 2-letter country code (`us`, `de`, `jp`)                        | Native only |
| `language`                           | ISO 639-1 language code (`en`, `fr`, `zh`)                      | Native only |
| `date_after` / `date_before`         | Published-date range in `YYYY-MM-DD`                            | Native only |
| `domain_filter`                      | Max 20 domains; allowlist or `-`-prefixed denylist, never mixed | Native only |
| `max_tokens` / `max_tokens_per_page` | Content budget across all results / per page                    | Native only |

`freshness` cannot be combined with `date_after` / `date_before`.

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

  <Accordion title="OpenRouter / Sonar compatibility (legacy)">
    Existing OpenClaw installs configured against Perplexity Sonar through OpenRouter continue to work. The plugin switches to the Sonar chat-completions transport when any of these is set:

    - `OPENROUTER_API_KEY` in the Gateway environment, when no higher-priority credential is available
    - An `sk-or-...` key stored in `plugins.entries.perplexity.config.webSearch.apiKey`
    - `plugins.entries.perplexity.config.webSearch.baseUrl` or `.model`

    Credential precedence is `plugins.entries.perplexity.config.webSearch.apiKey`, then `PERPLEXITY_API_KEY`, then `OPENROUTER_API_KEY`. The first available credential determines endpoint inference unless an explicit `baseUrl` or `model` forces the legacy transport.

    In that mode the provider returns one AI-synthesized answer with citations instead of structured Search API results. `count` is accepted for shared-tool compatibility but does not change that one-answer shape. The Search API filters `country`, `language`, `date_after`/`date_before`, `domain_filter`, `max_tokens`, and `max_tokens_per_page` return a `not supported` error on the chat-completions path; `freshness` still applies as `search_recency_filter`. New setups should use a `pplx-` key against the native Search API.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Perplexity search tool" href="/tools/perplexity-search" icon="magnifying-glass">
    How the agent invokes Perplexity searches and interprets results.
  </Card>
  <Card title="Perplexity Agent API" href="/providers/perplexity-agent-api" icon="robot">
    Use Perplexity's Agent API as an LLM model provider for OpenClaw.
  </Card>
</CardGroup>
