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

| Filter                               | Description                                                     |
| ------------------------------------ | --------------------------------------------------------------- |
| `count`                              | Results per search, 1-10 (default 5)                            |
| `freshness`                          | Recency window: `day`, `week`, `month`, `year`                  |
| `country`                            | 2-letter country code (`us`, `de`, `jp`)                        |
| `language`                           | ISO 639-1 language code (`en`, `fr`, `zh`)                      |
| `date_after` / `date_before`         | Published-date range in `YYYY-MM-DD`                            |
| `domain_filter`                      | Max 20 domains; allowlist or `-`-prefixed denylist, never mixed |
| `max_tokens` / `max_tokens_per_page` | Content budget across all results / per page                    |

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
