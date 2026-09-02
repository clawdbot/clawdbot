---
summary: "Exa AI search -- neural and keyword search with content extraction"
read_when:
  - You want to use Exa for web_search
  - You need an EXA_API_KEY
  - You want neural search or content extraction
title: "Exa search"
---

[Exa AI](https://exa.ai/) is a `web_search` provider with neural, keyword, and
hybrid search modes plus built-in content extraction (highlights, text,
summaries).

## Install plugin

```bash
openclaw plugins install @openclaw/exa-plugin
openclaw gateway restart
```

## Get an API key

<Steps>
  <Step title="Create an account">
    Sign up at [exa.ai](https://exa.ai/) and generate an API key from your
    dashboard.
  </Step>
  <Step title="Store the key">
    Set `EXA_API_KEY` in the Gateway environment, or configure via:

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

## Config

```json5
{
  plugins: {
    entries: {
      exa: {
        config: {
          webSearch: {
            apiKey: "exa-...", // optional if EXA_API_KEY is set
            baseUrl: "https://api.exa.ai", // optional; OpenClaw appends /search
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "exa",
      },
    },
  },
}
```

**Environment alternative:** set `EXA_API_KEY` in the Gateway environment. For
a gateway install, put it in `~/.openclaw/.env`. See
[Env vars](/help/faq#env-vars-and-env-loading).

## Base URL override

Set `plugins.entries.exa.config.webSearch.baseUrl` to route Exa search
requests through a compatible proxy or alternate endpoint. OpenClaw
normalizes bare hosts by prepending `https://` and appends `/search` unless
the path already ends there. The resolved endpoint is part of the search
cache key, so results from different endpoints are never shared.

## Tool parameters

<ParamField path="query" type="string" required>
Search query.
</ParamField>

<ParamField path="count" type="number" default="5">
Results to return (1-100, subject to Exa search-type limits).
</ParamField>

<ParamField path="type" type="'auto' | 'neural' | 'fast' | 'deep' | 'deep-reasoning' | 'instant'">
Search mode.
</ParamField>

<ParamField path="freshness" type="'day' | 'week' | 'month' | 'year'">
Time filter. Cannot be combined with `date_after`/`date_before`.
</ParamField>

<ParamField path="date_after" type="string">
Results after this date (`YYYY-MM-DD`).
</ParamField>

<ParamField path="date_before" type="string">
Results before this date (`YYYY-MM-DD`).
</ParamField>

<ParamField path="contents" type="object">
Content extraction options (see below).
</ParamField>

### Content extraction

Pass a `contents` object to control extracted content in results:

```javascript
await web_search({
  query: "transformer architecture explained",
  type: "neural",
  contents: {
    text: true, // full page text
    highlights: { numSentences: 3 }, // key sentences
    summary: true, // AI summary
  },
});
```

| Contents option | Type                                                                  | Description            |
| --------------- | --------------------------------------------------------------------- | ---------------------- |
| `text`          | `boolean \| { maxCharacters }`                                        | Extract full page text |
| `highlights`    | `boolean \| { maxCharacters, query, numSentences, highlightsPerUrl }` | Extract key sentences  |
| `summary`       | `boolean \| { query }`                                                | AI-generated summary   |

If `contents` is omitted, Exa defaults to `{ highlights: true }` so results
include key-sentence excerpts. Result descriptions resolve from highlights
first, then summary, then full text -- whichever is available first. Results
also preserve the raw `highlightScores` and `summary` fields from the Exa API
response when available.

### Search modes

| Mode             | Description                       |
| ---------------- | --------------------------------- |
| `auto`           | Exa picks the best mode (default) |
| `neural`         | Semantic/meaning-based search     |
| `fast`           | Quick keyword search              |
| `deep`           | Thorough deep search              |
| `deep-reasoning` | Deep search with reasoning        |
| `instant`        | Fastest results                   |

## Notes

- `count` accepts up to 100, subject to Exa search-type limits.
- Results are cached for 15 minutes by default. Configure the shared
  `tools.web.search.cacheTtlMinutes` (minutes) and
  `tools.web.search.timeoutSeconds` (default 30s) to change caching and
  request timeout for all `web_search` providers, including Exa.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Brave Search](/tools/brave-search) -- structured results with country/language filters
- [Perplexity Search](/tools/perplexity-search) -- structured results with domain filtering
