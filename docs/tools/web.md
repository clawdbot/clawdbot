---
summary: "web_search, x_search, and web_fetch -- search the web, search X posts, or fetch page content"
title: "Web search"
sidebarTitle: "Web Search"
read_when:
  - You want to enable or configure web_search
  - You want to enable or configure x_search
  - You need to choose a search provider
  - You want to understand auto-detection and provider fallback
---

The `web_search` tool searches the web using your configured provider and
returns results. Results are cached by query for 15 minutes (configurable).

OpenClaw also includes `x_search` for X (formerly Twitter) posts and
`web_fetch` for lightweight URL fetching. In this phase, `web_fetch` stays
local while `web_search` and `x_search` can use xAI Responses under the hood.

<Info>
  `web_search` is a lightweight HTTP tool, not browser automation. For
  JS-heavy sites or logins, use the [Web Browser](/tools/browser). For
  fetching a specific URL, use [Web Fetch](/tools/web-fetch).
</Info>

## Quick start

<Steps>
  <Step title="Choose a provider">
    Pick a provider and complete any required setup. Some providers are
    key-free, while others use API keys. See the provider pages below for
    details.
  </Step>
  <Step title="Configure">
    ```bash
    openclaw configure --section web
    ```
    This stores the provider and any needed credential. You can also set an env
    var (for example `BRAVE_API_KEY`) and skip this step for API-backed
    providers.
  </Step>
  <Step title="Use it">
    The agent can now call `web_search`:

    ```javascript
    await web_search({ query: "OpenClaw plugin SDK" });
    ```

    For X posts, use:

    ```javascript
    await x_search({ query: "dinner recipes" });
    ```

  </Step>
</Steps>

## Choosing a provider

<CardGroup cols={2}>
  <Card title="Brave Search" icon="shield" href="/tools/brave-search">
    Structured results with snippets. Supports `llm-context` mode, country/language filters. Free tier available.
  </Card>
  <Card title="DuckDuckGo" icon="bird" href="/tools/duckduckgo-search">
    Key-free fallback. No API key needed. Unofficial HTML-based integration.
  </Card>
  <Card title="Exa" icon="brain" href="/tools/exa-search">
    Neural + keyword search with content extraction (highlights, text, summaries).
  </Card>
  <Card title="Firecrawl" icon="flame" href="/tools/firecrawl">
    Structured results. Best paired with `firecrawl_search` and `firecrawl_scrape` for deep extraction.
  </Card>
  <Card title="Gemini" icon="sparkles" href="/tools/gemini-search">
    AI-synthesized answers with citations via Google Search grounding.
  </Card>
  <Card title="Grok" icon="zap" href="/tools/grok-search">
    AI-synthesized answers with citations via xAI web grounding.
  </Card>
  <Card title="Kimi" icon="moon" href="/tools/kimi-search">
    AI-synthesized answers with citations via Moonshot web search; ungrounded chat fallbacks fail explicitly.
  </Card>
  <Card title="MiniMax Search" icon="globe" href="/tools/minimax-search">
    Structured results via the MiniMax Token Plan search API.
  </Card>
  <Card title="Ollama Web Search" icon="globe" href="/tools/ollama-search">
    Search via a signed-in local Ollama host or the hosted Ollama API.
  </Card>
  <Card title="Perplexity" icon="search" href="/tools/perplexity-search">
    Structured results with content extraction controls and domain filtering.
  </Card>
  <Card title="SearXNG" icon="server" href="/tools/searxng-search">
    Self-hosted meta-search. No API key needed. Aggregates Google, Bing, DuckDuckGo, and more.
  </Card>
  <Card title="Tavily" icon="globe" href="/tools/tavily">
    Structured results with search depth, topic filtering, and `tavily_extract` for URL extraction.
  </Card>
</CardGroup>

### Provider comparison

| Provider                                  | Result style                                                   | Filters                                          | API key                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| [Brave](/tools/brave-search)              | Structured snippets                                            | Country, language, time, `llm-context` mode      | `BRAVE_API_KEY`                                                                         |
| [DuckDuckGo](/tools/duckduckgo-search)    | Structured snippets                                            | --                                               | None (key-free)                                                                         |
| [Exa](/tools/exa-search)                  | Structured + extracted                                         | Neural/keyword mode, date, content extraction    | `EXA_API_KEY`                                                                           |
| [Firecrawl](/tools/firecrawl)             | Structured snippets                                            | Via `firecrawl_search` tool                      | `FIRECRAWL_API_KEY`                                                                     |
| [Gemini](/tools/gemini-search)            | AI-synthesized + citations                                     | --                                               | `GEMINI_API_KEY`                                                                        |
| [Grok](/tools/grok-search)                | AI-synthesized + citations                                     | --                                               | `XAI_API_KEY`                                                                           |
| [Kimi](/tools/kimi-search)                | AI-synthesized + citations; fails on ungrounded chat fallbacks | --                                               | `KIMI_API_KEY` / `MOONSHOT_API_KEY`                                                     |
| [MiniMax Search](/tools/minimax-search)   | Structured snippets                                            | Region (`global` / `cn`)                         | `MINIMAX_CODE_PLAN_KEY` / `MINIMAX_CODING_API_KEY` / `MINIMAX_OAUTH_TOKEN`              |
| [Ollama Web Search](/tools/ollama-search) | Structured snippets                                            | --                                               | None for signed-in local hosts; `OLLAMA_API_KEY` for direct `https://ollama.com` search |
| [Perplexity](/tools/perplexity-search)    | Structured snippets                                            | Country, language, time, domains, content limits | `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY`                                             |
| [SearXNG](/tools/searxng-search)          | Structured snippets                                            | Categories, language                             | None (self-hosted)                                                                      |
| [Tavily](/tools/tavily)                   | Structured snippets                                            | Via `tavily_search` tool                         | `TAVILY_API_KEY`                                                                        |

## Auto-detection

## Native OpenAI web search

Direct OpenAI Responses models use OpenAI's hosted `web_search` tool automatically when OpenClaw web search is enabled and no managed provider is pinned. This is provider-owned behavior in the bundled OpenAI plugin and only applies to native OpenAI API traffic, not OpenAI-compatible proxy base URLs or Azure routes. Set `tools.web.search.provider` to another provider such as `brave` to keep the managed `web_search` tool for OpenAI models, or set `tools.web.search.enabled: false` to disable both managed search and native OpenAI search.

## Native Codex web search

Codex-capable models can optionally use the provider-native Responses `web_search` tool instead of OpenClaw's managed `web_search` function.

- Configure it under `tools.web.search.openaiCodex`
- It only activates for Codex-capable models (`openai-codex/*` or providers using `api: "openai-codex-responses"`)
- Managed `web_search` still applies to non-Codex models
- `mode: "cached"` is the default and recommended setting
- `tools.web.search.enabled: false` disables both managed and native search

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        openaiCodex: {
          enabled: true,
          mode: "cached",
          allowedDomains: ["example.com"],
          contextSize: "high",
          userLocation: {
            country: "US",
            city: "New York",
            timezone: "America/New_York",
          },
        },
      },
    },
  },
}
```

If native Codex search is enabled but the current model is not Codex-capable, OpenClaw keeps the normal managed `web_search` behavior.

## Setting up web search

Provider lists in docs and setup flows are alphabetical. Auto-detection keeps a
separate precedence order.

If no `provider` is set, OpenClaw checks providers in this order and uses the
first one that is ready:

API-backed providers first:

1. **Brave** -- `BRAVE_API_KEY` or `plugins.entries.brave.config.webSearch.apiKey` (order 10)
2. **MiniMax Search** -- `MINIMAX_CODE_PLAN_KEY` / `MINIMAX_CODING_API_KEY` / `MINIMAX_OAUTH_TOKEN` / `MINIMAX_API_KEY` or `plugins.entries.minimax.config.webSearch.apiKey` (order 15)
3. **Gemini** -- `plugins.entries.google.config.webSearch.apiKey`, `GEMINI_API_KEY`, or `models.providers.google.apiKey` (order 20)
4. **Grok** -- `XAI_API_KEY` or `plugins.entries.xai.config.webSearch.apiKey` (order 30)
5. **Kimi** -- `KIMI_API_KEY` / `MOONSHOT_API_KEY` or `plugins.entries.moonshot.config.webSearch.apiKey` (order 40)
6. **Perplexity** -- `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` or `plugins.entries.perplexity.config.webSearch.apiKey` (order 50)
7. **Firecrawl** -- `FIRECRAWL_API_KEY` or `plugins.entries.firecrawl.config.webSearch.apiKey` (order 60)
8. **Exa** -- `EXA_API_KEY` or `plugins.entries.exa.config.webSearch.apiKey`; optional `plugins.entries.exa.config.webSearch.baseUrl` overrides the Exa endpoint (order 65)
9. **Tavily** -- `TAVILY_API_KEY` or `plugins.entries.tavily.config.webSearch.apiKey` (order 70)

Key-free fallbacks after that:

10. **DuckDuckGo** -- key-free HTML fallback with no account or API key (order 100)
11. **Ollama Web Search** -- key-free fallback via your configured local Ollama host when it is reachable and signed in with `ollama signin`; can reuse Ollama provider bearer auth when the host needs it, and can call direct `https://ollama.com` search when configured with `OLLAMA_API_KEY` (order 110)
12. **SearXNG** -- `SEARXNG_BASE_URL` or `plugins.entries.searxng.config.webSearch.baseUrl` (order 200)

If no provider is detected, it falls back to Brave (you will get a missing-key
error prompting you to configure one).

<Note>
  All provider key fields support SecretRef objects. Plugin-scoped SecretRefs
  under `plugins.entries.<plugin>.config.webSearch.apiKey` are resolved for the
  bundled API-backed web search providers, including Brave, Exa, Firecrawl,
  Gemini, Grok, Kimi, MiniMax, Perplexity, and Tavily,
  whether the provider is picked explicitly via `tools.web.search.provider` or
  selected through auto-detect. In auto-detect mode, OpenClaw resolves only the
  selected provider key -- non-selected SecretRefs stay inactive, so you can
  keep multiple providers configured without paying resolution cost for the
  ones you are not using.
</Note>

## Config

```json5
{
  tools: {
    web: {
      search: {
        enabled: true, // default: true
        provider: "brave", // or omit for auto-detection
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

Provider-specific config (API keys, base URLs, modes) lives under
`plugins.entries.<plugin>.config.webSearch.*`. Gemini can also reuse
`models.providers.google.apiKey` and `models.providers.google.baseUrl` as lower-priority
fallbacks after its dedicated web-search config and `GEMINI_API_KEY`. See the
provider pages for examples.

`tools.web.search.provider` is validated against the web-search provider ids
declared by bundled and installed plugin manifests. A typo such as `"brvae"`
fails config validation instead of silently falling back to auto-detection. If a
configured provider only has stale plugin evidence, such as a leftover
`plugins.entries.<plugin>` block after uninstalling a third-party plugin,
OpenClaw keeps startup resilient and reports a warning so you can reinstall the
plugin or run `openclaw doctor --fix` to clean up the stale config.

`web_fetch` fallback provider selection is separate:

- choose it with `tools.web.fetch.provider`
- or omit that field and let OpenClaw auto-detect the first ready web-fetch
  provider from available credentials
- non-sandboxed `web_fetch` can use installed plugin providers that declare
  `contracts.webFetchProviders`; sandboxed fetches stay bundled-only
- today the bundled web-fetch provider is Firecrawl, configured under
  `plugins.entries.firecrawl.config.webFetch.*`

When you choose **Kimi** during `openclaw onboard` or
`openclaw configure --section web`, OpenClaw can also ask for:

- the Moonshot API region (`https://api.moonshot.ai/v1` or `https://api.moonshot.cn/v1`)
- the default Kimi web-search model (defaults to `kimi-k2.6`)

For `x_search`, configure `plugins.entries.xai.config.xSearch.*`. It uses the
same `XAI_API_KEY` fallback as Grok web search.
Legacy `tools.web.x_search.*` config is auto-migrated by `openclaw doctor --fix`.
When you choose Grok during `openclaw onboard` or `openclaw configure --section web`,
OpenClaw can also offer optional `x_search` setup with the same key.
This is a separate follow-up step inside the Grok path, not a separate top-level
web-search provider choice. If you pick another provider, OpenClaw does not
show the `x_search` prompt.

### Storing API keys

<Tabs>
  <Tab title="Config file">
    Run `openclaw configure --section web` or set the key directly:

    ```json5
    {
      plugins: {
        entries: {
          brave: {
            config: {
              webSearch: {
                apiKey: "YOUR_KEY", // pragma: allowlist secret
              },
            },
          },
        },
      },
    }
    ```

  </Tab>
  <Tab title="Environment variable">
    Set the provider env var in the Gateway process environment:

    ```bash
    export BRAVE_API_KEY="YOUR_KEY"
    ```

    For a gateway install, put it in `~/.openclaw/.env`.
    See [Env vars](/help/faq#env-vars-and-env-loading).

  </Tab>
</Tabs>

## Tool parameters

| Parameter             | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `query`               | Search query (required)                               |
| `count`               | Results to return (1-10, default: 5)                  |
| `country`             | 2-letter ISO country code (e.g. "US", "DE")           |
| `language`            | ISO 639-1 language code (e.g. "en", "de")             |
| `search_lang`         | Search-language code (Brave only)                     |
| `freshness`           | Time filter: `day`, `week`, `month`, or `year`        |
| `date_after`          | Results after this date (YYYY-MM-DD)                  |
| `date_before`         | Results before this date (YYYY-MM-DD)                 |
| `ui_lang`             | UI language code (Brave only)                         |
| `domain_filter`       | Domain allowlist/denylist array (Perplexity only)     |
| `max_tokens`          | Total content budget, default 25000 (Perplexity only) |
| `max_tokens_per_page` | Per-page token limit, default 2048 (Perplexity only)  |

<Warning>
  Not all parameters work with all providers. Brave `llm-context` mode
  rejects `ui_lang`; `date_before` also needs `date_after` because Brave custom
  freshness ranges require both start and end dates.
  Gemini, Grok, and Kimi return one synthesized answer with citations. They
  accept `count` for shared-tool compatibility, but it does not change the
  grounded answer shape. Gemini supports `freshness`, `date_after`, and
  `date_before` by converting them to Google Search grounding time ranges.
  Perplexity behaves the same way when you use the Sonar/OpenRouter
  compatibility path (`plugins.entries.perplexity.config.webSearch.baseUrl` /
  `model` or `OPENROUTER_API_KEY`).
  SearXNG accepts `http://` only for trusted private-network or loopback hosts;
  public SearXNG endpoints must use `https://`.
  Firecrawl and Tavily only support `query` and `count` through `web_search`
  -- use their dedicated tools for advanced options.
</Warning>

## x_search

`x_search` queries X (formerly Twitter) posts using xAI and returns
AI-synthesized answers with citations. It accepts natural-language queries and
optional structured filters. OpenClaw only enables the built-in xAI `x_search`
tool on the request that serves this tool call.

<Note>
  xAI documents `x_search` as supporting keyword search, semantic search, user
  search, and thread fetch. For per-post engagement stats such as reposts,
  replies, bookmarks, or views, prefer a targeted lookup for the exact post URL
  or status ID. Broad keyword searches may find the right post but return less
  complete per-post metadata. A good pattern is: locate the post first, then
  run a second `x_search` query focused on that exact post.
</Note>

### x_search config

```json5
{
  plugins: {
    entries: {
      xai: {
        config: {
          xSearch: {
            enabled: true,
            model: "grok-4-1-fast-non-reasoning",
            baseUrl: "https://api.x.ai/v1", // optional, overrides webSearch.baseUrl
            inlineCitations: false,
            maxTurns: 2,
            timeoutSeconds: 30,
            cacheTtlMinutes: 15,
          },
          webSearch: {
            apiKey: "xai-...", // optional if XAI_API_KEY is set
            baseUrl: "https://api.x.ai/v1", // optional shared xAI Responses base URL
          },
        },
      },
    },
  },
}
```

`x_search` posts to `<baseUrl>/responses` when
`plugins.entries.xai.config.xSearch.baseUrl` is set. If that field is omitted,
it falls back to `plugins.entries.xai.config.webSearch.baseUrl`, then the
legacy `tools.web.search.grok.baseUrl`, and finally the public xAI endpoint.

### x_search parameters

| Parameter                    | Description                                            |
| ---------------------------- | ------------------------------------------------------ |
| `query`                      | Search query (required)                                |
| `allowed_x_handles`          | Restrict results to specific X handles                 |
| `excluded_x_handles`         | Exclude specific X handles                             |
| `from_date`                  | Only include posts on or after this date (YYYY-MM-DD)  |
| `to_date`                    | Only include posts on or before this date (YYYY-MM-DD) |
| `enable_image_understanding` | Let xAI inspect images attached to matching posts      |
| `enable_video_understanding` | Let xAI inspect videos attached to matching posts      |

### x_search example

```javascript
await x_search({
  query: "dinner recipes",
  allowed_x_handles: ["nytfood"],
  from_date: "2026-03-01",
});
```

```javascript
// Per-post stats: use the exact status URL or status ID when possible
await x_search({
  query: "https://x.com/huntharo/status/1905678901234567890",
});
```

## Examples

```javascript
// Basic search
await web_search({ query: "OpenClaw plugin SDK" });

// German-specific search
await web_search({ query: "TV online schauen", country: "DE", language: "de" });

// Recent results (past week)
await web_search({ query: "AI developments", freshness: "week" });

// Date range
await web_search({
  query: "climate research",
  date_after: "2024-01-01",
  date_before: "2024-06-30",
});

// Domain filtering (Perplexity only)
await web_search({
  query: "product reviews",
  domain_filter: ["-reddit.com", "-pinterest.com"],
});
```

## Tool profiles

If you use tool profiles or allowlists, add `web_search`, `x_search`, or `group:web`:

```json5
{
  tools: {
    allow: ["web_search", "x_search"],
    // or: allow: ["group:web"]  (includes web_search, x_search, and web_fetch)
  },
}
```

## Related

- [Web Fetch](/tools/web-fetch) -- fetch a URL and extract readable content
- [Web Browser](/tools/browser) -- full browser automation for JS-heavy sites
- [Grok Search](/tools/grok-search) -- Grok as the `web_search` provider
- [Ollama Web Search](/tools/ollama-search) -- key-free web search through your Ollama host
