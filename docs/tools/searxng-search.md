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

The `baseUrl` field also accepts SecretRef objects.

Transport rules:

- `https://` works for public or private SearXNG hosts
- `http://` is only accepted for trusted private-network or loopback hosts
- public SearXNG hosts must use `https://`

## Environment variable

Set `SEARXNG_BASE_URL` as an alternative to config:

```bash
export SEARXNG_BASE_URL="http://localhost:8888"
```

When `SEARXNG_BASE_URL` is set and no explicit provider is configured, auto-detection
picks SearXNG automatically (at the lowest priority -- any API-backed provider with a
key wins first).

## Plugin config reference

| Field        | Description                                                        |
| ------------ | ------------------------------------------------------------------ |
| `baseUrl`    | Base URL of your SearXNG instance (required)                       |
| `categories` | Comma-separated categories such as `general`, `news`, or `science` |
| `language`   | Language code for results such as `en`, `de`, or `fr`              |

## Notes

- **JSON API** -- uses SearXNG's native `format=json` endpoint, not HTML scraping
- **No API key** -- works with any SearXNG instance out of the box
- **Base URL validation** -- `baseUrl` must be a valid `http://` or `https://`
  URL; public hosts must use `https://`
- **Auto-detection order** -- SearXNG is checked last (order 200) in
  auto-detection. API-backed providers with configured keys run first, then
  DuckDuckGo (order 100), then Ollama Web Search (order 110)
- **Self-hosted** -- you control the instance, queries, and upstream search engines
- **Categories** default to `general` when not configured

<Tip>
  For SearXNG JSON API to work, make sure your SearXNG instance has the `json`
  format enabled in its `settings.yml` under `search.formats`.
</Tip>

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [DuckDuckGo Search](/tools/duckduckgo-search) -- another key-free fallback
- [Brave Search](/tools/brave-search) -- structured results with free tier
