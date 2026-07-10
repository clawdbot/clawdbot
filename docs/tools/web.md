---
summary: "web_search, x_search, and web_fetch -- search the web, search X posts, or fetch page content"
title: "Web search"
sidebarTitle: "Web Search"
read_when:
  - You want to enable or configure web_search
  - You want to enable or configure x_search
  - You need to choose a search provider
  - You want to understand auto-detection and provider selection
---

`web_search` searches the web with your configured provider and returns
normalized results, cached by query for 15 minutes (configurable). OpenClaw
also bundles `x_search` for X (formerly Twitter) posts and `web_fetch` for
lightweight URL fetching. `web_fetch` always runs locally; `web_search` routes
through xAI Responses when Grok is the provider, and `x_search` always uses
xAI Responses.

<Info>
  `web_search` is a lightweight HTTP tool, not browser automation. For
  JS-heavy sites or logins, use the [Web Browser](/tools/browser). For
  fetching a specific URL, use [Web Fetch](/tools/web-fetch).
</Info>

## Quick start

<Steps>
  <Step title="Choose a provider">
    Pick a provider and complete any required setup. Some providers are
    key-free, others need an API key. See the provider pages below for
    details.
  </Step>
  <Step title="Configure">
    ```bash
    openclaw configure --section web
    ```
    This stores the provider and any needed credential. For API-backed
    providers you can instead set the provider's env var (for example
    `BRAVE_API_KEY`) and skip this step.
  </Step>
  <Step title="Use it">
    ```javascript
    await web_search({ query: "OpenClaw plugin SDK" });
    ```

    For X posts:

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
  <Card title="Codex Hosted Search" icon="search" href="/plugins/codex-harness">
    AI-synthesized grounded answers through your Codex app-server account.
  </Card>
  <Card title="DuckDuckGo" icon="bird" href="/tools/duckduckgo-search">
    Key-free provider. No API key needed. Unofficial HTML-based integration.
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
  <Card title="Parallel" icon="layer-group" href="/tools/parallel-search">
    Paid Parallel Search API (`PARALLEL_API_KEY`); higher rate limits and objective tuning.
  </Card>
  <Card title="Parallel Search (Free)" icon="layer-group" href="/tools/parallel-search">
    Key-free opt-in. Parallel's free Search MCP, with LLM-optimized dense excerpts and no API key.
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

| Provider                                         | Result style                                                   | Filters                                          | API key                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| [Brave](/tools/brave-search)                     | Structured snippets                                            | Country, language, time, `llm-context` mode      | `BRAVE_API_KEY`                                                                         |
| [Codex Hosted Search](/plugins/codex-harness)    | AI-synthesized + source URLs                                   | Domains, context size, user location             | None; uses Codex/OpenAI sign-in                                                         |
| [DuckDuckGo](/tools/duckduckgo-search)           | Structured snippets                                            | --                                               | None (key-free)                                                                         |
| [Exa](/tools/exa-search)                         | Structured + extracted                                         | Neural/keyword mode, date, content extraction    | `EXA_API_KEY`                                                                           |
| [Firecrawl](/tools/firecrawl)                    | Structured snippets                                            | Via `firecrawl_search` tool                      | `FIRECRAWL_API_KEY`                                                                     |
| [Gemini](/tools/gemini-search)                   | AI-synthesized + citations                                     | --                                               | `GEMINI_API_KEY`                                                                        |
| [Grok](/tools/grok-search)                       | AI-synthesized + citations                                     | --                                               | xAI OAuth, `XAI_API_KEY`, or `plugins.entries.xai.config.webSearch.apiKey`              |
| [Kimi](/tools/kimi-search)                       | AI-synthesized + citations; fails on ungrounded chat fallbacks | --                                               | `KIMI_API_KEY` / `MOONSHOT_API_KEY`                                                     |
| [MiniMax Search](/tools/minimax-search)          | Structured snippets                                            | Region (`global` / `cn`)                         | `MINIMAX_CODE_PLAN_KEY` / `MINIMAX_CODING_API_KEY` / `MINIMAX_OAUTH_TOKEN`              |
| [Ollama Web Search](/tools/ollama-search)        | Structured snippets                                            | --                                               | None for signed-in local hosts; `OLLAMA_API_KEY` for direct `https://ollama.com` search |
| [Parallel](/tools/parallel-search)               | Dense excerpts ranked for LLM context                          | --                                               | `PARALLEL_API_KEY` (paid)                                                               |
| [Parallel Search (Free)](/tools/parallel-search) | Dense excerpts ranked for LLM context                          | --                                               | None (free Search MCP)                                                                  |
| [Perplexity](/tools/perplexity-search)           | Structured snippets                                            | Country, language, time, domains, content limits | `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY`                                             |
| [SearXNG](/tools/searxng-search)                 | Structured snippets                                            | Categories, language                             | None (self-hosted)                                                                      |
| [Tavily](/tools/tavily)                          | Structured snippets                                            | Via `tavily_search` tool                         | `TAVILY_API_KEY`                                                                        |

## Auto-detection

Provider lists in docs and setup flows are alphabetical. Auto-detection uses a
separate, fixed precedence order and only picks a provider that needs a
credential (`requiresCredential !== false`) when it finds one configured. If
no `provider` is set, OpenClaw checks providers in this order and uses the
first one that is ready:

API-backed providers first:

1. **Brave** -- `BRAVE_API_KEY` or `plugins.entries.brave.config.webSearch.apiKey` (order 10)
2. **MiniMax Search** -- `MINIMAX_CODE_PLAN_KEY` / `MINIMAX_CODING_API_KEY` / `MINIMAX_OAUTH_TOKEN` / `MINIMAX_API_KEY` or `plugins.entries.minimax.config.webSearch.apiKey` (order 15)
3. **Gemini** -- `plugins.entries.google.config.webSearch.apiKey`, `GEMINI_API_KEY`, or `models.providers.google.apiKey` (order 20)
4. **Grok** -- xAI OAuth, `XAI_API_KEY`, or `plugins.entries.xai.config.webSearch.apiKey` (order 30)
5. **Kimi** -- `KIMI_API_KEY` / `MOONSHOT_API_KEY` or `plugins.entries.moonshot.config.webSearch.apiKey` (order 40)
6. **Perplexity** -- `PERPLEXITY_API_KEY` / `OPENROUTER_API_KEY` or `plugins.entries.perplexity.config.webSearch.apiKey` (order 50)
7. **Firecrawl** -- `FIRECRAWL_API_KEY` or `plugins.entries.firecrawl.config.webSearch.apiKey` (order 60)
8. **Exa** -- `EXA_API_KEY` or `plugins.entries.exa.config.webSearch.apiKey`; optional `plugins.entries.exa.config.webSearch.baseUrl` overrides the Exa endpoint (order 65)
9. **Tavily** -- `TAVILY_API_KEY` or `plugins.entries.tavily.config.webSearch.apiKey` (order 70)
10. **Parallel** -- paid Parallel Search API via `PARALLEL_API_KEY` or `plugins.entries.parallel.config.webSearch.apiKey`; optional `plugins.entries.parallel.config.webSearch.baseUrl` overrides the endpoint (order 75)

Configured endpoint providers after that:

11. **SearXNG** -- `SEARXNG_BASE_URL` or `plugins.entries.searxng.config.webSearch.baseUrl` (order 200)

Key-free providers such as **Parallel Search (Free)**, **DuckDuckGo**,
**Ollama Web Search**, and **Codex Hosted Search** never win auto-detection,
even though they have an internal order value. They are used only when you
select them explicitly with `tools.web.search.provider` or through
`openclaw configure --section web`. OpenClaw does not send managed
`web_search` queries to a key-free provider just because no API-backed
provider is configured.

OpenAI Responses models are an exception: while `tools.web.search.provider`
is unset, they use OpenAI's native web search instead of the managed
providers above (see below). Set `tools.web.search.provider` to
`parallel-free` (or another provider) to route them through the managed path
instead.

<Note>
  All provider key fields support SecretRef objects. Plugin-scoped SecretRefs
  under `plugins.entries.<plugin>.config.webSearch.apiKey` are resolved for the
  installed API-backed web search providers, including Brave, Exa, Firecrawl,
  Gemini, Grok, Kimi, MiniMax, Parallel, Perplexity, and Tavily,
  whether the provider is picked explicitly via `tools.web.search.provider` or
  selected through auto-detect. In auto-detect mode, OpenClaw resolves only the
  selected provider key -- non-selected SecretRefs stay inactive, so you can
  keep multiple providers configured without paying resolution cost for the
  ones you are not using.
</Note>

## Native OpenAI web search

Direct OpenAI Responses models (`api: "openai-responses"`, provider `openai`,
no base URL or an official OpenAI API base URL) use OpenAI's hosted
`web_search` tool automatically when OpenClaw web search is enabled and no
managed provider is pinned. This is provider-owned behavior in the bundled
OpenAI plugin and does not apply to OpenAI-compatible proxy base URLs or Azure
routes. Set `tools.web.search.provider` to another provider such as `brave` to
keep the managed `web_search` tool for OpenAI models, or set
`tools.web.search.enabled: false` to disable both managed search and native
OpenAI search.

## Native Codex web search

The Codex app-server runtime uses Codex's hosted `web_search` tool automatically
when web search is enabled and no managed provider is selected. Native hosted
search and OpenClaw's managed `web_search` dynamic tool are mutually exclusive,
so managed search cannot bypass native domain restrictions. OpenClaw uses the
managed tool when hosted search is unavailable, explicitly disabled, or
replaced by a selected managed provider. OpenClaw keeps Codex's standalone
`web.run` extension disabled (`features.standalone_web_search: false`)
because production app-server traffic rejects its user-defined `web`
namespace.

- Configure native search under `tools.web.search.openaiCodex`
- Set `tools.web.search.provider: "codex"` to provision Codex Hosted Search as
  the managed `web_search` provider for any parent model. Each call runs a
  bounded ephemeral Codex app-server turn and fails if Codex does not emit a
  hosted `webSearch` item.
- `mode: "cached"` is the default preference, but Codex resolves it to live
  external access for unrestricted app-server turns; set `"live"` to request
  live access explicitly
- Set `tools.web.search.provider` to a managed provider such as `brave` to use
  OpenClaw's managed `web_search` instead
- Set `tools.web.search.openaiCodex.enabled: false` to opt out of Codex-hosted
  search; other managed providers remain available
- Restricting the Codex native tool surface also keeps managed `web_search`
  available
- When `allowedDomains` is set, automatic managed fallback fails closed if
  hosted search is unavailable so the native allowlist cannot be bypassed
- Tool-disabled LLM-only runs disable both native and managed search
- `tools.web.search.enabled: false` disables both managed and native search

Persistent effective Codex search-policy changes start a fresh bound thread so
an already loaded app-server thread cannot keep stale hosted-search access.
Transient per-turn restrictions use a temporary restricted thread and preserve
the existing binding for later resume.

Direct OpenAI ChatGPT Responses traffic can also use OpenAI's hosted
`web_search` tool. That separate path remains opt-in through
`tools.web.search.openaiCodex.enabled: true` and only applies to eligible
`openai/*` models using `api: "openai-chatgpt-responses"`.

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        // Optional: use Codex Hosted Search from non-Codex parent models too.
        provider: "codex",
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

For runtimes and providers that do not support native Codex search, Codex can
use the managed `web_search` fallback through OpenClaw's dynamic tool namespace.
Use an explicit managed provider when you need OpenClaw's provider-specific
network controls instead of Codex-hosted search.

Selecting `provider: "codex"` enables the bundled `codex` plugin and uses the
same `tools.web.search.openaiCodex` restrictions shown above. Authenticate the
Codex app-server first with `openclaw models auth login --provider openai`.
The parent agent can use any model or runtime; only the bounded search worker
runs through Codex.

## Network safety

Managed HTTP `web_search` provider calls use OpenClaw's guarded fetch path,
scoped to the current provider's own hostname. For that hostname only,
OpenClaw allows Surge, Clash, and sing-box fake-IP DNS answers in
`198.18.0.0/15` and `fc00::/7`. Other private, loopback, link-local, and
metadata destinations remain blocked. Codex Hosted Search is the exception:
its bounded worker delegates network access to Codex app-server's hosted
`web_search` tool.

This automatic allowance does not apply to arbitrary `web_fetch` URLs. For
`web_fetch`, enable `tools.web.fetch.ssrfPolicy.allowRfc2544BenchmarkRange` and
`tools.web.fetch.ssrfPolicy.allowIpv6UniqueLocalRange` explicitly only when your
trusted proxy owns those synthetic ranges.

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
Grok can also reuse an xAI OAuth auth profile from `openclaw models auth login
--provider xai --method oauth`; API-key config remains the fallback.

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
  provider from configured credentials
- non-sandboxed `web_fetch` can use installed plugin providers that declare
  `contracts.webFetchProviders`; sandboxed fetches allow bundled providers and
  verified official plugin installs, but exclude third-party external plugins
- the official Firecrawl plugin is the only bundled `webFetchProviders`
  contributor today, configured under
  `plugins.entries.firecrawl.config.webFetch.*`

When you choose **Kimi** during `openclaw onboard` or
`openclaw configure --section web`, OpenClaw can also ask for:

- the Moonshot API region (`https://api.moonshot.ai/v1` or `https://api.moonshot.cn/v1`)
- the default Kimi web-search model (defaults to `kimi-k2.6`)

For `x_search`, configure `plugins.entries.xai.config.xSearch.*`. It uses the
same xAI auth profile as chat, or the `XAI_API_KEY` / plugin web-search
credential used by Grok web search.
Legacy `tools.web.x_search.*` config is auto-migrated by `openclaw doctor --fix`.
When you choose Grok during `openclaw onboard` or `openclaw configure --section web`,
OpenClaw also offers optional `x_search` setup with the same credential right
after Grok setup completes. This is a separate follow-up step inside the Grok
path, not a separate top-level web-search provider choice. If you pick another
provider, OpenClaw does not show the `x_search` prompt.

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

| Parameter             | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `query`               | Search query (required)                                            |
| `count`               | Results to return (1-10, default: 5)                               |
| `country`             | 2-letter ISO country code (e.g. "US", "DE")                        |
| `language`            | ISO 639-1 language code (e.g. "en", "de")                          |
| `search_lang`         | Search-language code (Brave only)                                  |
| `freshness`           | Time filter: `day`, `week`, `month`, or `year`                     |
| `date_after`          | Results after this date (YYYY-MM-DD)                               |
| `date_before`         | Results before this date (YYYY-MM-DD)                              |
| `ui_lang`             | UI language code (Brave only)                                      |
| `domain_filter`       | Domain allowlist/denylist array (Perplexity only)                  |
| `max_tokens`          | Total content token budget, native Perplexity Search API only      |
| `max_tokens_per_page` | Per-page extraction token limit, native Perplexity Search API only |

<Warning>
  Not all parameters work with all providers. Brave `llm-context` mode
  rejects `ui_lang`; `date_before` also needs `date_after` because Brave custom
  freshness ranges require both start and end dates.
  Gemini, Grok, and Kimi return one synthesized answer with citations. They
  accept `count` for shared-tool compatibility, but it does not change the
  grounded answer shape. Gemini treats `day` freshness as a recency hint; wider
  freshness values and explicit dates set Google Search grounding time ranges.
  Perplexity behaves the same way when you use the Sonar/OpenRouter
  compatibility path (`plugins.entries.perplexity.config.webSearch.baseUrl` /
  `model` or `OPENROUTER_API_KEY`); that path also drops `max_tokens` and
  `max_tokens_per_page` support.
  SearXNG accepts `http://` only for trusted private-network or loopback hosts;
  public SearXNG endpoints must use `https://`.
  Firecrawl and Tavily only support `query` and `count` through `web_search`
  -- use their dedicated tools for advanced options.
</Warning>

## x_search

`x_search` queries X (formerly Twitter) posts using xAI and returns
AI-synthesized answers with citations. It accepts natural-language queries and
optional structured filters. OpenClaw constructs the built-in xAI `x_search`
tool per request rather than keeping it permanently registered, so it is only
active for the turn that actually calls it.

<Warning>
  `x_search` runs on xAI's servers. xAI bills $5 per 1,000 tool calls, plus the
  model's input and output tokens.
</Warning>

<Note>
  xAI documents `x_search` as supporting keyword search, semantic search, user
  search, and thread fetch. For per-post engagement stats such as reposts,
  replies, bookmarks, or views, prefer a targeted lookup for the exact post URL
  or status ID. Broad keyword searches may find the right post but return less
  complete per-post metadata. A good pattern is: locate the post first, then
  run a second `x_search` query focused on that exact post.
</Note>

### x_search config

With `enabled` omitted, `x_search` is exposed only when the active model's
provider is `xai` and xAI credentials resolve. For an active model with a known
non-xAI provider, set `plugins.entries.xai.config.xSearch.enabled` to `true` to
opt in to cross-provider use. If the active model provider is missing or
unresolved, the tool stays hidden. Set `enabled` to `false` to disable it for
every provider. xAI credentials are always required.

```json5
{
  plugins: {
    entries: {
      xai: {
        config: {
          xSearch: {
            enabled: true, // required for a known non-xAI model provider
            model: "grok-4.3",
            baseUrl: "https://api.x.ai/v1", // optional, overrides webSearch.baseUrl
            inlineCitations: false,
            maxTurns: 2,
            timeoutSeconds: 30,
            cacheTtlMinutes: 15,
          },
          webSearch: {
            apiKey: "xai-...", // optional if an xAI auth profile or XAI_API_KEY is set
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
legacy `tools.web.search.grok.baseUrl`, and finally the public xAI endpoint
(`https://api.x.ai/v1`).

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
