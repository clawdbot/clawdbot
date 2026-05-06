---
summary: "Brave Search API setup for web_search"
read_when:
  - You want to use Brave Search for web_search
  - You need a BRAVE_API_KEY or plan details
title: "Brave search"
---

OpenClaw supports Brave Search API as a `web_search` provider.

## Get an API key

1. Create a Brave Search API account at [https://brave.com/search/api/](https://brave.com/search/api/)
2. In the dashboard, choose the **Search** plan and generate an API key.
3. Store the key in config or set `BRAVE_API_KEY` in the Gateway environment.

## Config example

```json5
{
  plugins: {
    entries: {
      brave: {
        config: {
          webSearch: {
            apiKey: "BRAVE_API_KEY_HERE",
            mode: "web", // or "llm-context"
            baseUrl: "https://api.search.brave.com", // optional proxy/base URL override
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "brave",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

Provider-specific Brave search settings now live under `plugins.entries.brave.config.webSearch.*`.
Legacy `tools.web.search.apiKey` still loads through the compatibility shim, but it is no longer the canonical config path.

`webSearch.mode` controls the Brave transport:

- `web` (default): normal Brave web search with titles, URLs, and snippets
- `llm-context`: Brave LLM Context API with pre-extracted text chunks and sources for grounding

`webSearch.baseUrl` can point Brave requests at a trusted Brave-compatible proxy
or gateway. OpenClaw appends `/res/v1/web/search` or `/res/v1/llm/context` to
the configured base URL and keeps the base URL in the cache key. Public
endpoints must use `https://`; `http://` is accepted only for trusted loopback
or private-network proxy hosts.

## Tool parameters

<ParamField path="query" type="string" required>
Search query.
</ParamField>

<ParamField path="count" type="number" default="5">
Number of results to return (1–10).
</ParamField>

<ParamField path="country" type="string">
2-letter ISO country code (e.g. `US`, `DE`).
</ParamField>

<ParamField path="language" type="string">
ISO 639-1 language code for search results (e.g. `en`, `de`, `fr`).
</ParamField>

<ParamField path="search_lang" type="string">
Brave search-language code (e.g. `en`, `en-gb`, `zh-hans`).
</ParamField>

<ParamField path="ui_lang" type="string">
ISO language code for UI elements.
</ParamField>

<ParamField path="freshness" type="'day' | 'week' | 'month' | 'year'">
Time filter — `day` is 24 hours.
</ParamField>

<ParamField path="date_after" type="string">
Only results published after this date (`YYYY-MM-DD`).
</ParamField>

<ParamField path="date_before" type="string">
Only results published before this date (`YYYY-MM-DD`).
</ParamField>

**Examples:**

```javascript
// Country and language-specific search
await web_search({
  query: "renewable energy",
  country: "DE",
  language: "de",
});

// Recent results (past week)
await web_search({
  query: "AI news",
  freshness: "week",
});

// Date range search
await web_search({
  query: "AI developments",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});
```

## Notes

- OpenClaw uses the Brave **Search** plan. If you have a legacy subscription (e.g. the original Free plan with 2,000 queries/month), it remains valid but does not include newer features like LLM Context or higher rate limits.
- Each Brave plan includes **\$5/month in free credit** (renewing). The Search plan costs \$5 per 1,000 requests, so the credit covers 1,000 queries/month. Set your usage limit in the Brave dashboard to avoid unexpected charges. See the [Brave API portal](https://brave.com/search/api/) for current plans.
- The Search plan includes the LLM Context endpoint and AI inference rights. Storing results to train or tune models requires a plan with explicit storage rights. See the Brave [Terms of Service](https://api-dashboard.search.brave.com/terms-of-service).
- `llm-context` mode returns grounded source entries instead of the normal web-search snippet shape.
- `llm-context` mode supports `freshness` and bounded `date_after` + `date_before` ranges. It does not support `ui_lang`; `date_before` without `date_after` is rejected because Brave requires custom freshness ranges to include both start and end dates.
- `ui_lang` must include a region subtag like `en-US`.
- Results are cached for 15 minutes by default (configurable via `cacheTtlMinutes`).
- Custom `webSearch.baseUrl` values are included in Brave cache identity, so
  proxy-specific responses do not collide.
- Enable the `brave.http` diagnostics flag to log Brave request URLs/query params, response status/timing, and search-cache hit/miss/write events while troubleshooting. The flag never logs the API key or response bodies, but search queries can be sensitive.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Perplexity Search](/tools/perplexity-search) -- structured results with domain filtering
- [Exa Search](/tools/exa-search) -- neural search with content extraction
