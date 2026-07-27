---
summary: "Firecrawl search, scrape, and web_fetch fallback"
read_when:
  - You want Firecrawl-backed web extraction
  - You want keyless Firecrawl Search (Free) or keyless web_fetch
  - You need a Firecrawl API key for search or higher limits
  - You want Firecrawl as a web_search provider
  - You want anti-bot extraction for web_fetch
title: "Firecrawl"
---

OpenClaw can use **Firecrawl** in three ways:

- as the `web_search` provider
- as explicit plugin tools: `firecrawl_search` and `firecrawl_scrape`
- as a fallback extractor for `web_fetch`

It is a hosted extraction/search service that supports bot circumvention and caching, which helps with JS-heavy sites or pages that block plain HTTP fetches.

## Install plugin

Install the official plugin, then restart Gateway:

```bash
openclaw plugins install @openclaw/firecrawl-plugin
openclaw gateway restart
```

## Keyless access and API keys

Firecrawl registers two `web_search` providers:

- **Firecrawl Search** (`firecrawl`) — uses the hosted `/v2/search` API with your
  key; auto-detected when a key is present.
- **Firecrawl Search (Free)** (`firecrawl-free`) — uses the hosted keyless starter
  tier, no API key required. It is **opt-in only** and never auto-selected, since
  selecting it sends your search queries to Firecrawl's free tier.

The explicitly selected Firecrawl `web_fetch` fallback is also keyless. The
explicit `firecrawl_search` and `firecrawl_scrape` tools require an API key. Add
`FIRECRAWL_API_KEY` in the gateway environment or configure it for higher limits.

## Configure Firecrawl search

```json5
{
  tools: {
    web: {
      search: {
        provider: "firecrawl",
      },
    },
  },
  plugins: {
    entries: {
      firecrawl: {
        enabled: true,
        config: {
          webSearch: {
            apiKey: "FIRECRAWL_API_KEY_HERE",
            baseUrl: "https://api.firecrawl.dev",
          },
        },
      },
    },
  },
}
```

Notes:

- Choosing Firecrawl in onboarding or `openclaw configure --section web` enables the installed Firecrawl plugin automatically.
- Pick **Firecrawl Search (Free)** in onboarding (or set `provider: "firecrawl-free"`) to run keyless with no API key. The keyed **Firecrawl Search** provider sends `plugins.entries.firecrawl.config.webSearch.apiKey` or `FIRECRAWL_API_KEY`.
- `web_search` with Firecrawl supports `query` and `count`.
- For Firecrawl-specific controls like `sources`, `categories`, or result scraping, use `firecrawl_search`.
- `baseUrl` defaults to hosted Firecrawl at `https://api.firecrawl.dev`. Self-hosted overrides are allowed only for private/internal endpoints; HTTP is accepted only for those private targets.
- `FIRECRAWL_BASE_URL` is the shared env fallback for Firecrawl search and scrape base URLs.
- Firecrawl search requests default to a 30-second timeout; `firecrawl_search`'s `timeoutSeconds` parameter overrides it per call.

## Configure Firecrawl web_fetch fallback

```json5
{
  tools: {
    web: {
      fetch: {
        provider: "firecrawl", // explicit selection enables keyless fallback
      },
    },
  },
  plugins: {
    entries: {
      firecrawl: {
        enabled: true,
        config: {
          webFetch: {
            baseUrl: "https://api.firecrawl.dev",
            onlyMainContent: true,
            maxAgeMs: 172800000,
            timeoutSeconds: 60,
          },
        },
      },
    },
  },
}
```

Notes:

- The explicitly selected Firecrawl `web_fetch` fallback works without an API key. When configured, OpenClaw sends `plugins.entries.firecrawl.config.webFetch.apiKey` or `FIRECRAWL_API_KEY` for higher limits.
- Choosing Firecrawl during onboarding or `openclaw configure --section web` enables the plugin and selects Firecrawl for `web_fetch` unless another fetch provider is already configured.
- `firecrawl_scrape` requires an API key.
- `maxAgeMs` controls how old cached results can be (ms). Default is 172,800,000 ms (2 days).
- `onlyMainContent` defaults to `true`; `timeoutSeconds` defaults to 60.
- Legacy `tools.web.fetch.firecrawl.*` and `tools.web.search.firecrawl.*` config is auto-migrated by `openclaw doctor --fix`.
- Firecrawl scrape/base URL overrides follow the same hosted/private rule as search: public hosted traffic uses `https://api.firecrawl.dev`; self-hosted overrides must resolve to private/internal endpoints.
- `firecrawl_scrape` rejects obvious private, loopback, metadata, and non-HTTP(S) target URLs before forwarding them to Firecrawl, matching the `web_fetch` target-safety contract for explicit Firecrawl scrape calls.

`firecrawl_scrape` reuses the same `plugins.entries.firecrawl.config.webFetch.*` settings and env vars, including its required API key.

### Self-hosted Firecrawl

Set `plugins.entries.firecrawl.config.webSearch.baseUrl`, `plugins.entries.firecrawl.config.webFetch.baseUrl`, or `FIRECRAWL_BASE_URL` when you run Firecrawl yourself. OpenClaw accepts `http://` only for loopback, private-network, `.local`, `.internal`, or `.localhost` targets. Public custom hosts are rejected so Firecrawl API keys are not sent to arbitrary endpoints by accident.

## Firecrawl plugin tools

### `firecrawl_search`

Use this when you want Firecrawl-specific search controls instead of generic `web_search`. Requires an API key.

Parameters:

- `query`
- `count` (1-100)
- `sources`
- `categories`
- `includeDomains` / `excludeDomains` (hostnames only; mutually exclusive)
- `tbs` (time filter, for example `qdr:d`, `qdr:w`, `sbd:1`)
- `location` and `country` (geo-targeting)
- `scrapeResults`
- `timeoutSeconds`

### `firecrawl_scrape`

Use this for JS-heavy or bot-protected pages where plain `web_fetch` is weak.

Parameters:

- `url`
- `extractMode`
- `maxChars`
- `onlyMainContent`
- `maxAgeMs`
- `proxy`
- `storeInCache`
- `timeoutSeconds`

## Stealth / bot circumvention

`firecrawl_scrape` and the `web_fetch` Firecrawl fallback default to `proxy: "auto"` plus `storeInCache: true` unless the caller overrides those parameters. `firecrawl_search` and the `web_search` Firecrawl provider have no `proxy`/`storeInCache` controls; stealth proxy mode only applies to scrape/fetch requests.

Firecrawl's `proxy` mode controls bot circumvention (`basic`, `stealth`, or `auto`). `auto` retries with stealth proxies if a basic attempt fails, which may use more credits than basic-only scraping.

## How `web_fetch` uses Firecrawl

`web_fetch` extraction order:

1. Readability (local)
2. Configured fetch provider, such as Firecrawl (when selected, or auto-detected from configured credentials)
3. Basic HTML cleanup (last fallback)

The selection knob is `tools.web.fetch.provider`. If you omit it, OpenClaw auto-detects the first ready web-fetch provider from available credentials. The official Firecrawl plugin provides that fallback.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Web Fetch](/tools/web-fetch) -- web_fetch tool with Firecrawl fallback
- [Tavily](/tools/tavily) -- search + extract tools
