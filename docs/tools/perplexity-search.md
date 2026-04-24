---
summary: "Perplexity Search API and Sonar/OpenRouter compatibility for web_search"
read_when:
  - You want to use Perplexity Search for web search
  - You need PERPLEXITY_API_KEY or OPENROUTER_API_KEY setup
title: "Perplexity search"
---

# Perplexity Search API

OpenClaw supports Perplexity Search API as a `web_search` provider.
It returns structured results with `title`, `url`, and `snippet` fields.

For compatibility, OpenClaw also supports legacy Perplexity Sonar/OpenRouter setups.
If you use `OPENROUTER_API_KEY`, an `sk-or-...` key in `plugins.entries.perplexity.config.webSearch.apiKey`, or set `plugins.entries.perplexity.config.webSearch.baseUrl` / `model`, the provider switches to the chat-completions path and returns AI-synthesized answers with citations instead of structured Search API results.

## Getting a Perplexity API key

1. Create a Perplexity account at [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api)
2. Generate an API key in the dashboard
3. Store the key in config or set `PERPLEXITY_API_KEY` in the Gateway environment.

## OpenRouter compatibility

If you were already using OpenRouter for Perplexity Sonar, keep `provider: "perplexity"` and set `OPENROUTER_API_KEY` in the Gateway environment, or store an `sk-or-...` key in `plugins.entries.perplexity.config.webSearch.apiKey`.

Optional compatibility controls:

- `plugins.entries.perplexity.config.webSearch.baseUrl`
- `plugins.entries.perplexity.config.webSearch.model`

## Config examples

### Native Perplexity Search API

```json5
{
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            apiKey: "pplx-...",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "perplexity",
      },
    },
  },
}
```

### OpenRouter / Sonar compatibility

```json5
{
  plugins: {
    entries: {
      perplexity: {
        config: {
          webSearch: {
            apiKey: "<openrouter-api-key>",
            baseUrl: "https://openrouter.ai/api/v1",
            model: "perplexity/sonar-pro",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "perplexity",
      },
    },
  },
}
```

## Where to set the key

**Via config:** run `openclaw configure --section web`. It stores the key in
`~/.openclaw/openclaw.json` under `plugins.entries.perplexity.config.webSearch.apiKey`.
That field also accepts SecretRef objects.

**Via environment:** set `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY`
in the Gateway process environment. For a gateway install, put it in
`~/.openclaw/.env` (or your service environment). See [Env vars](/help/faq#env-vars-and-env-loading).

If `provider: "perplexity"` is configured and the Perplexity key SecretRef is unresolved with no env fallback, startup/reload fails fast.

## Tool parameters

These parameters apply to the native Perplexity Search API path.

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
ISO 639-1 language code (e.g. `en`, `de`, `fr`).
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

<ParamField path="domain_filter" type="string[]">
Domain allowlist/denylist array (max 20).
</ParamField>

<ParamField path="max_tokens" type="number" default="25000">
Total content budget (max 1000000).
</ParamField>

<ParamField path="max_tokens_per_page" type="number" default="2048">
Per-page token limit.
</ParamField>

For the legacy Sonar/OpenRouter compatibility path:

- `query`, `count`, and `freshness` are accepted
- `count` is compatibility-only there; the response is still one synthesized
  answer with citations rather than an N-result list
- Search API-only filters such as `country`, `language`, `date_after`,
  `date_before`, `domain_filter`, `max_tokens`, and `max_tokens_per_page`
  return explicit errors

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

// Domain filtering (allowlist)
await web_search({
  query: "climate research",
  domain_filter: ["nature.com", "science.org", ".edu"],
});

// Domain filtering (denylist - prefix with -)
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"],
});

// More content extraction
await web_search({
  query: "detailed AI research",
  max_tokens: 50000,
  max_tokens_per_page: 4096,
});
```

### Domain filter rules

- Maximum 20 domains per filter
- Cannot mix allowlist and denylist in the same request
- Use `-` prefix for denylist entries (e.g., `["-reddit.com"]`)

## Notes

- Perplexity Search API returns structured web search results (`title`, `url`, `snippet`)
- OpenRouter or explicit `plugins.entries.perplexity.config.webSearch.baseUrl` / `model` switches Perplexity back to Sonar chat completions for compatibility
- Sonar/OpenRouter compatibility returns one synthesized answer with citations, not structured result rows
- Results are cached for 15 minutes by default (configurable via `cacheTtlMinutes`)

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Perplexity Search API docs](https://docs.perplexity.ai/docs/search/quickstart) -- official Perplexity documentation
- [Brave Search](/tools/brave-search) -- structured results with country/language filters
- [Exa Search](/tools/exa-search) -- neural search with content extraction
