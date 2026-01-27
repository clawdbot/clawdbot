---
summary: "Perplexity Search API setup for web_search"
read_when:
  - You want to use Perplexity Search for web search
  - You need PERPLEXITY_API_KEY setup
---

# Perplexity Search API

Moltbot uses Perplexity Search API for the `web_search` tool when `provider: "perplexity"` is set.
Perplexity Search returns structured results (title, URL, snippet) for fast research.

## Getting a Perplexity API key

1) Create a Perplexity account at https://www.perplexity.ai/settings/api
2) Generate an API key in the dashboard
3) Store the key in config (recommended) or set `PERPLEXITY_API_KEY` in the Gateway environment.

## Config example

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-..."
        }
      }
    }
  }
}
```

## Switching from Brave

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-..."
        }
      }
    }
  }
}
```

## Where to set the key (recommended)

**Recommended:** run `moltbot configure --section web`. It stores the key in
`~/.clawdbot/moltbot.json` under `tools.web.search.perplexity.apiKey`.

**Environment alternative:** set `PERPLEXITY_API_KEY` in the Gateway process
environment. For a gateway install, put it in `~/.clawdbot/.env` (or your
service environment). See [Env vars](/help/faq#how-does-moltbot-load-environment-variables).

## Tool parameters

| Parameter | Description |
|-----------|-------------|
| `query` | Search query (required) |
| `count` | Number of results to return (1-10, default: 5) |
| `country` | 2-letter ISO country code (e.g., "US", "DE") |
| `language` | ISO 639-1 language code (e.g., "en", "de", "fr") |
| `freshness` | Time filter: `day` (24h), `week`, `month`, or `year` |
| `date_after` | Only results published after this date (YYYY-MM-DD) |
| `date_before` | Only results published before this date (YYYY-MM-DD) |
| `domain_filter` | Domain allowlist/denylist array (max 20) |
| `max_tokens` | Total content budget (default: 25000, max: 1000000) |
| `max_tokens_per_page` | Per-page token limit (default: 2048) |

**Examples:**

```javascript
// Country and language-specific search
await web_search({
  query: "renewable energy",
  country: "DE",
  language: "de"
});

// Recent results (past week)
await web_search({
  query: "AI news",
  freshness: "week"
});

// Date range search
await web_search({
  query: "AI developments",
  date_after: "2024-01-01",
  date_before: "2024-06-30"
});

// Domain filtering (allowlist)
await web_search({
  query: "climate research",
  domain_filter: ["nature.com", "science.org", ".edu"]
});

// Domain filtering (denylist - prefix with -)
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"]
});

// More content extraction
await web_search({
  query: "detailed AI research",
  max_tokens: 50000,
  max_tokens_per_page: 4096
});
```

### Domain filter rules

- Maximum 20 domains per filter
- Cannot mix allowlist and denylist in the same request
- Use `-` prefix for denylist entries (e.g., `["-reddit.com"]`)

## Notes

- Perplexity Search API returns structured web search results (title, URL, snippet)
- Results are cached for 15 minutes by default (configurable via `cacheTtlMinutes`)

See [Web tools](/tools/web) for the full web_search configuration.
See [Perplexity Search API docs](https://docs.perplexity.ai/guides/search-quickstart) for more details.
