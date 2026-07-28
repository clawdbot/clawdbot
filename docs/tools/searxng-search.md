---
summary: "SearXNG web search -- self-hosted, key-free meta-search provider"
read_when:
  - You want a self-hosted web search provider
  - You want to use SearXNG for web_search
  - You need a privacy-focused or air-gapped search option
title: "SearXNG search"
---

OpenClaw supports [SearXNG](https://docs.searxng.org/) as a **self-hosted,
key-free** `web_search` provider. SearXNG is an open-source meta-search engine
that aggregates results from Google, Bing, DuckDuckGo, and other sources.

Advantages:

- **Free and unlimited** -- no API key or commercial subscription required
- **Privacy / air-gap** -- queries never leave your network
- **Works anywhere** -- no region restrictions on commercial search APIs

## Setup

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/searxng-plugin
    ```
  </Step>
  <Step title="Run a SearXNG instance">
    ```bash
    docker run -d -p 8888:8080 searxng/searxng
    ```

    Or use any existing SearXNG deployment you have access to. See the
    [SearXNG documentation](https://docs.searxng.org/) for production setup.

  </Step>
  <Step title="Configure">
    ```bash
    openclaw configure --section web
    # Select "searxng" as the provider
    ```

    Or set the env var and let auto-detection find it:

    ```bash
    export SEARXNG_BASE_URL="http://localhost:8888"
    ```

  </Step>
</Steps>

## Config

```json5
{
  tools: {
    web: {
      search: {
        provider: "searxng",
      },
    },
  },
}
```

Plugin-level settings for the SearXNG instance:

```json5
{
  plugins: {
    entries: {
      searxng: {
        config: {
          webSearch: {
            baseUrl: "http://localhost:8888",
            categories: "general,news", // optional
            language: "en", // optional
          },
        },
      },
    },
  },
}
```

`baseUrl` also accepts a SecretRef object (for example `{ source: "env", id: "SEARXNG_BASE_URL" }`).

## Environment variable

Set `SEARXNG_BASE_URL` as an alternative to config:

```bash
export SEARXNG_BASE_URL="http://localhost:8888"
```

Resolution order: configured `baseUrl` string, then an inline env SecretRef on
`baseUrl`, then `SEARXNG_BASE_URL`. When none of the config paths are set and
`SEARXNG_BASE_URL` is present with no explicit provider chosen, auto-detection
picks SearXNG.

## Plugin config reference

| Field        | Description                                                        |
| ------------ | ------------------------------------------------------------------ |
| `baseUrl`    | Base URL of your SearXNG instance (required)                       |
| `categories` | Comma-separated categories such as `general`, `news`, or `science` |
| `language`   | Language code for results such as `en`, `de`, or `fr`              |

The `web_search` tool call also accepts `count` (1-10 results), `categories`,
and `language` as per-call overrides.

## Notes

- **JSON API** -- uses SearXNG's native `format=json` endpoint, not HTML scraping
- **Image result URLs** -- image-category results include `img_src` when SearXNG
  returns a direct image URL
- **No API key** -- works with any SearXNG instance out of the box
- **Base URL validation** -- `baseUrl` must be a valid `http://` or `https://`
  URL
- **Network guard** -- `http://` base URLs must target a trusted private or
  loopback host (public hosts must use `https://`); `https://` base URLs that
  resolve to a private/internal address get the same self-hosted allowance,
  while `https://` base URLs that resolve publicly keep strict SSRF protection
- **Auto-detection order** -- SearXNG requires a configured `baseUrl` (order
  200 among providers that already have their required credential). Key-free
  providers such as DuckDuckGo or Ollama Web Search never win auto-detection
  implicitly; they only activate on an explicit `provider` choice
- **Self-hosted** -- you control the instance, queries, and upstream search engines
- **Categories** default to `general` when not configured
- **Category fallback** -- if a non-`general` category request succeeds but
  returns zero results, OpenClaw retries the same query once with `general`
  before returning an empty result set
- **Result caching** -- identical queries (same query, count, categories,
  language, and base URL) are cached in-process for a short TTL
- **Version requirement** -- the plugin declares `minHostVersion: >=2026.6.9`

<Tip>
  For SearXNG JSON API to work, make sure your SearXNG instance has the `json`
  format enabled in its `settings.yml` under `search.formats`.
</Tip>

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [DuckDuckGo Search](/tools/duckduckgo-search) -- another key-free provider
- [Brave Search](/tools/brave-search) -- structured results with free tier
