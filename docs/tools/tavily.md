---
summary: "Tavily search and extract tools"
read_when:
  - You want Tavily-backed web search
  - You need a Tavily API key
  - You want Tavily as a web_search provider
  - You want content extraction from URLs
title: "Tavily"
---

[Tavily](https://tavily.com) is a search API designed for AI applications. OpenClaw exposes it in two ways:

- as the `web_search` provider for the generic search tool
- as explicit plugin tools: `tavily_search` and `tavily_extract`

Tavily returns structured results optimized for LLM consumption with configurable search depth, topic filtering, domain filters, AI-generated answer summaries, and content extraction from URLs (including JavaScript-rendered pages).

| Property      | Value                               |
| ------------- | ----------------------------------- |
| Plugin id     | `tavily`                            |
| Auth          | `TAVILY_API_KEY` or config `apiKey` |
| Base URL      | `https://api.tavily.com` (default)  |
| Bundled tools | `tavily_search`, `tavily_extract`   |

## Getting started

<Steps>
  <Step title="Get an API key">
    Create a Tavily account at [tavily.com](https://tavily.com), then generate an API key in the dashboard.
  </Step>
  <Step title="Configure the plugin and provider">
    ```json5
    {
      plugins: {
        entries: {
          tavily: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: "tvly-...", // optional if TAVILY_API_KEY is set
                baseUrl: "https://api.tavily.com",
              },
            },
          },
        },
      },
      tools: {
        web: {
          search: {
            provider: "tavily",
          },
        },
      },
    }
    ```
  </Step>
  <Step title="Verify search runs">
    Trigger a `web_search` from any agent, or call `tavily_search` directly.
  </Step>
</Steps>

<Tip>
Choosing Tavily in onboarding or `openclaw configure --section web` enables the bundled Tavily plugin automatically.
</Tip>

## Tool reference

### `tavily_search`

Use this when you want Tavily-specific search controls instead of generic `web_search`.

| Parameter         | Type         | Constraints / default                  | Description                                     |
| ----------------- | ------------ | -------------------------------------- | ----------------------------------------------- |
| `query`           | string       | required                               | Search query string. Keep under 400 characters. |
| `search_depth`    | enum         | `basic` (default), `advanced`          | `advanced` is slower but higher relevance.      |
| `topic`           | enum         | `general` (default), `news`, `finance` | Filter by topic family.                         |
| `max_results`     | integer      | 1-20                                   | Number of results.                              |
| `include_answer`  | boolean      | default `false`                        | Include a Tavily AI-generated answer summary.   |
| `time_range`      | enum         | `day`, `week`, `month`, `year`         | Filter results by recency.                      |
| `include_domains` | string array | (none)                                 | Only include results from these domains.        |
| `exclude_domains` | string array | (none)                                 | Exclude results from these domains.             |

Search depth tradeoff:

| Depth      | Speed  | Relevance | Best for                             |
| ---------- | ------ | --------- | ------------------------------------ |
| `basic`    | Faster | High      | General-purpose queries (default).   |
| `advanced` | Slower | Highest   | Precision research and fact-finding. |

### `tavily_extract`

Use this to extract clean content from one or more URLs. Handles JavaScript-rendered pages and supports query-focused chunking for targeted extraction.

| Parameter           | Type         | Constraints / default         | Description                                                 |
| ------------------- | ------------ | ----------------------------- | ----------------------------------------------------------- |
| `urls`              | string array | required, 1-20                | URLs to extract content from.                               |
| `query`             | string       | (optional)                    | Rerank extracted chunks by relevance to this query.         |
| `extract_depth`     | enum         | `basic` (default), `advanced` | Use `advanced` for JS-heavy pages, SPAs, or dynamic tables. |
| `chunks_per_source` | integer      | 1-5; **requires `query`**     | Chunks returned per URL. Errors if set without `query`.     |
| `include_images`    | boolean      | default `false`               | Include image URLs in results.                              |

Extract depth tradeoff:

| Depth      | When to use                                |
| ---------- | ------------------------------------------ |
| `basic`    | Simple pages. Try this first.              |
| `advanced` | JS-rendered SPAs, dynamic content, tables. |

<Tip>
Batch larger URL lists into multiple `tavily_extract` calls (max 20 per request). Use `query` plus `chunks_per_source` to get only relevant content instead of full pages.
</Tip>

## Choosing the right tool

| Need                                 | Tool             |
| ------------------------------------ | ---------------- |
| Quick web search, no special options | `web_search`     |
| Search with depth, topic, AI answers | `tavily_search`  |
| Extract content from specific URLs   | `tavily_extract` |

<Note>
The generic `web_search` tool with Tavily as provider supports `query` and `count` (up to 20 results). For Tavily-specific controls (`search_depth`, `topic`, `include_answer`, domain filters, time range), use `tavily_search` instead.
</Note>

## Advanced configuration

<AccordionGroup>
  <Accordion title="API key resolution order">
    The Tavily client looks up its API key in this order:

    1. `plugins.entries.tavily.config.webSearch.apiKey` (resolved through SecretRefs).
    2. `TAVILY_API_KEY` from the gateway environment.

    `tavily_extract` raises a setup error if neither is present.

  </Accordion>

  <Accordion title="Custom base URL">
    Override `plugins.entries.tavily.config.webSearch.baseUrl` if you front Tavily through a proxy. The default is `https://api.tavily.com`.
  </Accordion>

  <Accordion title="`chunks_per_source` requires `query`">
    `tavily_extract` rejects calls that pass `chunks_per_source` without a `query`. Tavily ranks chunks by query relevance, so the parameter is meaningless without one.
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Web Search overview" href="/tools/web" icon="magnifying-glass">
    All providers and auto-detection rules.
  </Card>
  <Card title="Firecrawl" href="/tools/firecrawl" icon="fire">
    Search plus scraping with content extraction.
  </Card>
  <Card title="Exa Search" href="/tools/exa-search" icon="binoculars">
    Neural search with content extraction.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config schema for plugin entries and tool routing.
  </Card>
</CardGroup>
