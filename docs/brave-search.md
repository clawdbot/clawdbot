---
summary: "Brave Search API setup for web_search"
read_when:
  - You want to use Brave Search for web_search
  - You need a BRAVE_API_KEY or plan details
---

# Brave Search API

Moltbot supports Brave Search as a web search provider for `web_search`.

## Get an API key

1) Create a Brave Search API account at https://brave.com/search/api/
2) In the dashboard, choose the **Data for Search** plan and generate an API key.
3) Store the key in config (recommended) or set `BRAVE_API_KEY` in the Gateway environment.

## Config example

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30
      }
    }
  }
}
```

## Tool parameters

| Parameter | Description |
|-----------|-------------|
| `query` | Search query (required) |
| `count` | Number of results to return (1-10, default: 5) |
| `country` | 2-letter ISO country code (e.g., "US", "DE") |
| `language` | ISO 639-1 language code for search results (e.g., "en", "de", "fr") |
| `ui_lang` | ISO language code for UI elements |
| `freshness` | Time filter: `day` (24h), `week`, `month`, or `year` |
| `date_after` | Only results published after this date (YYYY-MM-DD) |
| `date_before` | Only results published before this date (YYYY-MM-DD) |

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
```

## Notes

- The Data for AI plan is **not** compatible with `web_search`.
- Brave provides a free tier plus paid plans; check the Brave API portal for current limits.
- Results are cached for 15 minutes by default (configurable via `cacheTtlMinutes`).

See [Web tools](/tools/web) for the full web_search configuration.
