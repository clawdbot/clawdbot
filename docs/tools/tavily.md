---
summary: "Tavily search and extract tools"
read_when:
  - You want Tavily-backed web search
  - You need a Tavily API key
  - You want Tavily as a web_search provider
  - You want content extraction from URLs
title: "Tavily"
---

OpenClaw can use **Tavily** in two ways:

- as the `web_search` provider
- as explicit plugin tools: `tavily_search` and `tavily_extract`

Tavily is a search API designed for AI applications, returning structured results
optimized for LLM consumption. It supports configurable search depth, topic
filtering, domain filters, AI-generated answer summaries, and content extraction
from URLs (including JavaScript-rendered pages).

## Get an API key

1. Create a Tavily account at [tavily.com](https://tavily.com/).
2. Generate an API key in the dashboard.
3. Store it in config or set `TAVILY_API_KEY` in the gateway environment.

## Configure Tavily search

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

Notes:

- Choosing Tavily in onboarding or `openclaw configure --section web` enables
  the bundled Tavily plugin automatically.
- Store Tavily config under `plugins.entries.tavily.config.webSearch.*`.
- `web_search` with Tavily supports `query` and `count` (up to 20 results).
- For Tavily-specific controls like `search_depth`, `topic`, `include_answer`,
  or domain filters, use `tavily_search`.

## Tavily plugin tools

### `tavily_search`

Use this when you want Tavily-specific search controls instead of generic
`web_search`.

| Parameter         | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `query`           | Search query string (keep under 400 characters)                       |
| `search_depth`    | `basic` (default, balanced) or `advanced` (highest relevance, slower) |
| `topic`           | `general` (default), `news` (real-time updates), or `finance`         |
| `max_results`     | Number of results, 1-20 (default: 5)                                  |
| `include_answer`  | Include an AI-generated answer summary (default: false)               |
| `time_range`      | Filter by recency: `day`, `week`, `month`, or `year`                  |
| `include_domains` | Array of domains to restrict results to                               |
| `exclude_domains` | Array of domains to exclude from results                              |

**Search depth:**

| Depth      | Speed  | Relevance | Best for                            |
| ---------- | ------ | --------- | ----------------------------------- |
| `basic`    | Faster | High      | General-purpose queries (default)   |
| `advanced` | Slower | Highest   | Precision, specific facts, research |

### `tavily_extract`

Use this to extract clean content from one or more URLs. Handles
JavaScript-rendered pages and supports query-focused chunking for targeted
extraction.

| Parameter           | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `urls`              | Array of URLs to extract (1-20 per request)                |
| `query`             | Rerank extracted chunks by relevance to this query         |
| `extract_depth`     | `basic` (default, fast) or `advanced` (for JS-heavy pages) |
| `chunks_per_source` | Chunks per URL, 1-5 (requires `query`)                     |
| `include_images`    | Include image URLs in results (default: false)             |

**Extract depth:**

| Depth      | When to use                               |
| ---------- | ----------------------------------------- |
| `basic`    | Simple pages - try this first             |
| `advanced` | JS-rendered SPAs, dynamic content, tables |

Tips:

- Max 20 URLs per request. Batch larger lists into multiple calls.
- Use `query` + `chunks_per_source` to get only relevant content instead of full pages.
- Try `basic` first; fall back to `advanced` if content is missing or incomplete.

## Choosing the right tool

| Need                                 | Tool             |
| ------------------------------------ | ---------------- |
| Quick web search, no special options | `web_search`     |
| Search with depth, topic, AI answers | `tavily_search`  |
| Extract content from specific URLs   | `tavily_extract` |

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Firecrawl](/tools/firecrawl) -- search + scraping with content extraction
- [Exa Search](/tools/exa-search) -- neural search with content extraction
