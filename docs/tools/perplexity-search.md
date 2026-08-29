---
summary: "Perplexity Search API for web_search"
read_when:
  - You want to use Perplexity Search for web search
  - You need PERPLEXITY_API_KEY setup
title: "Perplexity search"
---

OpenClaw supports the Perplexity Search API as a `web_search` provider. It returns structured results with `title`, `url`, and `snippet` fields.

## Install plugin

Install the official plugin, then restart Gateway:

```bash
openclaw plugins install @openclaw/perplexity-plugin
openclaw gateway restart
```

## Getting a Perplexity API key

1. Create a Perplexity account at [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api).
2. Generate an API key in the dashboard.
3. Store the key in config or set `PERPLEXITY_API_KEY` in the Gateway environment.

## Config example

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

## Where to set the key

**Via config:** run `openclaw configure --section web`. It stores the key in `~/.openclaw/openclaw.json` under `plugins.entries.perplexity.config.webSearch.apiKey`. That field also accepts SecretRef objects.

**Via environment:** set `PERPLEXITY_API_KEY` in the Gateway process environment. For a gateway install, put it in `~/.openclaw/.env` (or your service environment). See [Env vars](/help/faq#env-vars-and-env-loading).

If `provider: "perplexity"` is configured and the Perplexity key SecretRef is unresolved with no env fallback, startup/reload fails fast.

## OpenRouter / Sonar compatibility (legacy)

Existing installs pointed at Perplexity Sonar through OpenRouter continue to work. The provider switches to the Sonar chat-completions transport when any of these is set:

- `OPENROUTER_API_KEY` in the Gateway environment, when no higher-priority credential is available
- An `sk-or-...` key stored in `plugins.entries.perplexity.config.webSearch.apiKey`
- `plugins.entries.perplexity.config.webSearch.baseUrl` or `.model`

Credential precedence is `plugins.entries.perplexity.config.webSearch.apiKey`, then `PERPLEXITY_API_KEY`, then `OPENROUTER_API_KEY`. The first available credential determines endpoint inference unless an explicit `baseUrl` or `model` forces the legacy transport.

In that mode the provider returns one AI-synthesized answer with citations instead of structured Search API results. `count` is accepted for shared-tool compatibility but does not change that one-answer shape. The Search API filter parameters `country`, `language`, `date_after`/`date_before`, `domain_filter`, `max_tokens`, and `max_tokens_per_page` return a `not supported` error on the chat-completions path; `freshness` still applies as `search_recency_filter`. New setups should use a `pplx-` key against the native Search API.

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

## Tool parameters

<ParamField path="query" type="string" required>
Search query.
</ParamField>

<ParamField path="count" type="number" default="5">
Native Perplexity Search API only. Number of results to return (1-10). The legacy Sonar/OpenRouter transport accepts this parameter for compatibility but still returns one synthesized answer with citations, not an N-result list.
</ParamField>

<ParamField path="country" type="string">
2-letter ISO country code (e.g. `US`, `DE`).
</ParamField>

<ParamField path="language" type="string">
ISO 639-1 language code (e.g. `en`, `de`, `fr`).
</ParamField>

<ParamField path="freshness" type="'day' | 'week' | 'month' | 'year'">
Time filter - `day` is 24 hours.
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

- Maximum 20 domains per filter.
- Cannot mix allowlist and denylist entries in the same request.
- Use a `-` prefix for denylist entries (e.g., `["-reddit.com"]`).

## Notes

- Perplexity Search API returns structured web search results (`title`, `url`, `snippet`).
- Results are cached for 15 minutes by default (configurable via `cacheTtlMinutes`).

## Related

<CardGroup cols={2}>
  <Card title="Web search overview" href="/tools/web" icon="globe">
    All providers and auto-detection rules.
  </Card>
  <Card title="Brave search" href="/tools/brave-search" icon="shield">
    Structured results with country and language filters.
  </Card>
  <Card title="Exa search" href="/tools/exa-search" icon="magnifying-glass">
    Neural search with content extraction.
  </Card>
  <Card title="Perplexity Search API docs" href="https://docs.perplexity.ai/docs/search/quickstart" icon="arrow-up-right-from-square">
    Official Perplexity Search API quickstart and reference.
  </Card>
</CardGroup>
