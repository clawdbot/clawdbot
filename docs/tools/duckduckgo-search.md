---
summary: "DuckDuckGo web search -- key-free fallback provider (experimental, HTML-based)"
read_when:
  - You want a web search provider that requires no API key
  - You want to use DuckDuckGo for web_search
  - You need a zero-config search fallback
title: "DuckDuckGo search"
---

OpenClaw supports DuckDuckGo as a **key-free** `web_search` provider. No API
key or account is required.

<Warning>
  DuckDuckGo is an **experimental, unofficial** integration that pulls results
  from DuckDuckGo's non-JavaScript search pages — not an official API. Expect
  occasional breakage from bot-challenge pages or HTML changes.
</Warning>

## Setup

No API key needed — just set DuckDuckGo as your provider:

<Steps>
  <Step title="Configure">
    ```bash
    openclaw configure --section web
    # Select "duckduckgo" as the provider
    ```
  </Step>
</Steps>

## Config

```json5
{
  tools: {
    web: {
      search: {
        provider: "duckduckgo",
      },
    },
  },
}
```

Optional plugin-level settings for region and SafeSearch:

```json5
{
  plugins: {
    entries: {
      duckduckgo: {
        config: {
          webSearch: {
            region: "us-en", // DuckDuckGo region code
            safeSearch: "moderate", // "strict", "moderate", or "off"
          },
        },
      },
    },
  },
}
```

## Tool parameters

| Parameter    | Description                                                |
| ------------ | ---------------------------------------------------------- |
| `query`      | Search query (required)                                    |
| `count`      | Results to return (1-10, default: 5)                       |
| `region`     | DuckDuckGo region code (e.g. `us-en`, `uk-en`, `de-de`)    |
| `safeSearch` | SafeSearch level: `strict`, `moderate` (default), or `off` |

Region and SafeSearch can also be set in plugin config (see above) — tool
parameters override config values per-query.

## Notes

- **No API key** — works out of the box, zero configuration
- **Experimental** — gathers results from DuckDuckGo's non-JavaScript HTML
  search pages, not an official API or SDK
- **Bot-challenge risk** — DuckDuckGo may serve CAPTCHAs or block requests
  under heavy or automated use
- **HTML parsing** — results depend on page structure, which can change without
  notice
- **Auto-detection order** — DuckDuckGo is the first key-free fallback
  (order 100) in auto-detection. API-backed providers with configured keys run
  first, then Ollama Web Search (order 110), then SearXNG (order 200)
- **SafeSearch defaults to moderate** when not configured

<Tip>
  For production use, consider [Brave Search](/tools/brave-search) (free tier
  available) or another API-backed provider.
</Tip>

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Brave Search](/tools/brave-search) -- structured results with free tier
- [Exa Search](/tools/exa-search) -- neural search with content extraction
