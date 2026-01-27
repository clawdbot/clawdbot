---
summary: "Web search + fetch tools (Perplexity Search API, Brave Search API)"
read_when:
  - You want to enable web_search or web_fetch
  - You need Perplexity or Brave Search API key setup
---

# Web tools

Moltbot ships two lightweight web tools:

- `web_search` — Search the web using Perplexity Search API or Brave Search API.
- `web_fetch` — HTTP fetch + readable extraction (HTML → markdown/text).

These are **not** browser automation. For JS-heavy sites or logins, use the
[Browser tool](/tools/browser).

## How it works

- `web_search` calls your configured provider and returns results.
- Results are cached by query for 15 minutes (configurable).
- `web_fetch` does a plain HTTP GET and extracts readable content
  (HTML → markdown/text). It does **not** execute JavaScript.
- `web_fetch` is enabled by default (unless explicitly disabled).

See [Perplexity Search setup](/perplexity) and [Brave Search setup](/brave-search) for provider-specific details.

## Choosing a search provider

| Provider                  | Pros                                                                                         | Cons                          | API Key                                        |
|---------------------------|----------------------------------------------------------------------------------------------|-------------------------------|------------------------------------------------|
| **Perplexity Search API** | Fast, structured results; domain, language, region, and freshness filters; content extraction options; free credits for Moltbot users | —                             | Requires Perplexity API key `PERPLEXITY_API_KEY` |
| **Brave Search API**      | Fast, structured results; free tier available                                                | Fewer filtering options       | Requires Brave API key `BRAVE_API_KEY`         |


Set the provider in config:

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity"  // or "brave"
      }
    }
  }
}
```

## Setting up web search

Use `moltbot configure --section web` to set up your API key and choose a provider.

### Perplexity Search

1) Create a Perplexity account at https://www.perplexity.ai/settings/api
2) Generate an API key in the dashboard
3) Run `moltbot configure --section web` to store the key in config, or set `PERPLEXITY_API_KEY` in your environment.

Perplexity provides $5 in API credits on a monthly rolling basis to Perplexity Pro subscribers. Additionally, Perplexity provides complementary credits for Moltbot users.

See [Perplexity Search API Docs](https://docs.perplexity.ai/guides/search-quickstart) for more details.

### Brave Search

1) Create a Brave Search API account at https://brave.com/search/api/
2) In the dashboard, choose the **Data for Search** plan (not "Data for AI") and generate an API key.
3) Run `moltbot configure --section web` to store the key in config (recommended), or set `BRAVE_API_KEY` in your environment.

Brave provides a free tier plus paid plans; check the Brave API portal for the current limits and pricing.

### Where to store the key

**Via config (recommended):** run `moltbot configure --section web`. It stores the key under `tools.web.search.perplexity.apiKey` or `tools.web.search.apiKey`.

**Via environment:** set `PERPLEXITY_API_KEY` or `BRAVE_API_KEY` in the Gateway process environment. For a gateway install, put it in `~/.clawdbot/.env` (or your service environment). See [Env vars](/help/faq#how-does-moltbot-load-environment-variables).

### Config examples

**Perplexity Search:**

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-..."  // optional if PERPLEXITY_API_KEY is set
        }
      }
    }
  }
}
```

**Brave Search:**

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "brave",
        apiKey: "BSA..."  // optional if BRAVE_API_KEY is set
      }
    }
  }
}
```

## web_search

Search the web using your configured provider.

### Requirements

- `tools.web.search.enabled` must not be `false` (default: enabled)
- API key for your chosen provider:
  - **Brave**: `BRAVE_API_KEY` or `tools.web.search.apiKey`
  - **Perplexity**: `PERPLEXITY_API_KEY` or `tools.web.search.perplexity.apiKey`

### Config

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15
      }
    }
  }
}
```

### Tool parameters

All parameters work for both Brave and Perplexity unless noted.

| Parameter | Description |
|-----------|-------------|
| `query` | Search query (required) |
| `count` | Results to return (1-10, default: 5) |
| `country` | 2-letter ISO country code (e.g., "US", "DE") |
| `language` | ISO 639-1 language code (e.g., "en", "de") |
| `freshness` | Time filter: `day`, `week`, `month`, or `year` |
| `date_after` | Results after this date (YYYY-MM-DD) |
| `date_before` | Results before this date (YYYY-MM-DD) |
| `ui_lang` | UI language code (Brave only) |
| `domain_filter` | Domain allowlist/denylist array (Perplexity only) |
| `max_tokens` | Total content budget, default 25000 (Perplexity only) |
| `max_tokens_per_page` | Per-page token limit, default 2048 (Perplexity only) |

**Examples:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  country: "DE",
  language: "de"
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "week"
});

// Date range search
await web_search({
  query: "AI developments",
  date_after: "2024-01-01",
  date_before: "2024-06-30"
});

// Domain filtering (Perplexity only)
await web_search({
  query: "climate research",
  domain_filter: ["nature.com", "science.org", ".edu"]
});

// Exclude domains (Perplexity only)
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"]
});

// More content extraction (Perplexity only)
await web_search({
  query: "detailed AI research",
  max_tokens: 50000,
  max_tokens_per_page: 4096
});
```

## web_fetch

Fetch a URL and extract readable content.

### Requirements

- `tools.web.fetch.enabled` must not be `false` (default: enabled)
- Optional Firecrawl fallback: set `tools.web.fetch.firecrawl.apiKey` or `FIRECRAWL_API_KEY`.

### Config

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60
        }
      }
    }
  }
}
```

### Tool parameters

- `url` (required, http/https only)
- `extractMode` (`markdown` | `text`)
- `maxChars` (truncate long pages)

Notes:
- `web_fetch` uses Readability (main-content extraction) first, then Firecrawl (if configured). If both fail, the tool returns an error.
- Firecrawl requests use bot-circumvention mode and cache results by default.
- `web_fetch` sends a Chrome-like User-Agent and `Accept-Language` by default; override `userAgent` if needed.
- `web_fetch` blocks private/internal hostnames and re-checks redirects (limit with `maxRedirects`).
- `web_fetch` is best-effort extraction; some sites will need the browser tool.
- See [Firecrawl](/tools/firecrawl) for key setup and service details.
- Responses are cached (default 15 minutes) to reduce repeated fetches.
- If you use tool profiles/allowlists, add `web_search`/`web_fetch` or `group:web`.
- If the Brave key is missing, `web_search` returns a short setup hint with a docs link.
