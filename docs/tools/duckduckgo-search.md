---
summary: "DuckDuckGo web search -- key-free provider (experimental, HTML-based)"
read_when:
  - You want a web search provider that requires no API key
  - You want to use DuckDuckGo for web_search
  - You want an explicitly selected key-free search provider
title: "DuckDuckGo search"
---

OpenClaw supports DuckDuckGo as a **key-free** `web_search` provider. No API key or account is required.

<Warning>
  DuckDuckGo is an **experimental, unofficial** integration that scrapes DuckDuckGo's non-JavaScript HTML search pages -- not an official API. Expect occasional breakage from bot-challenge pages or HTML changes.
</Warning>

## Setup

DuckDuckGo is never auto-selected, since auto-detection only considers providers with usable credentials. Set it explicitly:

<Steps>
  <Step title="Configure">
    ```bash
    openclaw configure --section web
    # Select "duckduckgo" as the provider
    ```
  </Step>
</Steps>

## Config

Set the provider directly in config:

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

<ParamField path="query" type="string" required>
Search query.
</ParamField>

<ParamField path="count" type="number" default="5">
Results to return (1-10).
</ParamField>

<ParamField path="region" type="string">
DuckDuckGo region code (e.g. `us-en`, `uk-en`, `de-de`).
</ParamField>

<ParamField path="safeSearch" type="'strict' | 'moderate' | 'off'" default="moderate">
SafeSearch level.
</ParamField>

`region` and `safeSearch` tool parameters override the plugin config values above on a per-query basis.

## Notes

- **No API key** -- works once DuckDuckGo is selected as the `web_search` provider.
- **Experimental** -- scrapes DuckDuckGo's non-JavaScript HTML search pages, not an official API or SDK. Results depend on page structure, which can change without notice.
- **Bot-challenge risk** -- DuckDuckGo may serve CAPTCHAs or block requests under heavy or automated use.
- **Explicit selection only** -- OpenClaw's auto-detect only considers providers with usable credentials, so a key-free provider like DuckDuckGo is never chosen automatically; you must set `provider: "duckduckgo"`.
- **SafeSearch defaults to `moderate`** when not configured.

<Tip>
  For production use, consider [Brave Search](/tools/brave-search) (free tier available) or another API-backed provider.
</Tip>

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Brave Search](/tools/brave-search) -- structured results with free tier
- [Exa Search](/tools/exa-search) -- neural search with content extraction
