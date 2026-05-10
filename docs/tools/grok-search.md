---
summary: "Grok web search via xAI web-grounded responses"
read_when:
  - You want to use Grok for web_search
  - You need an XAI_API_KEY for web search
title: "Grok search"
---

OpenClaw supports Grok as a `web_search` provider, using xAI web-grounded
responses to produce AI-synthesized answers backed by live search results
with citations.

The same xAI API key can also power the built-in `x_search` tool for X
(formerly Twitter) post search and the `code_execution` tool. If you store the
key under `plugins.entries.xai.config.webSearch.apiKey`, OpenClaw now reuses it
as a fallback for the bundled xAI model provider too.

For post-level X metrics such as reposts, replies, bookmarks, or views, prefer
`x_search` with the exact post URL or status ID instead of a broad search
query.

## Onboarding and configure

If you choose **Grok** during:

- `openclaw onboard`
- `openclaw configure --section web`

OpenClaw can show a separate follow-up step to enable `x_search` with the same
`XAI_API_KEY`. That follow-up:

- only appears after you choose Grok for `web_search`
- is not a separate top-level web-search provider choice
- can optionally set the `x_search` model during the same flow

If you skip it, you can enable or change `x_search` later in config.

## Get an API key

<Steps>
  <Step title="Create a key">
    Get an API key from [xAI](https://console.x.ai/).
  </Step>
  <Step title="Store the key">
    Set `XAI_API_KEY` in the Gateway environment, or configure via:

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
      xai: {
        config: {
          webSearch: {
            apiKey: "xai-...", // optional if XAI_API_KEY is set
            baseUrl: "https://api.x.ai/v1", // optional Responses API proxy/base URL override
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "grok",
      },
    },
  },
}
```

**Environment alternative:** set `XAI_API_KEY` in the Gateway environment.
For a gateway install, put it in `~/.openclaw/.env`.

## How it works

Grok uses xAI web-grounded responses to synthesize answers with inline
citations, similar to Gemini's Google Search grounding approach.

## Supported parameters

Grok search supports `query`.

`count` is accepted for shared `web_search` compatibility, but Grok still
returns one synthesized answer with citations rather than an N-result list.

Provider-specific filters are not currently supported.

Grok uses a provider-specific 60 second default timeout because xAI Responses
web-grounded searches can run longer than the shared `web_search` default. Set
`tools.web.search.timeoutSeconds` to override it.

## Base URL overrides

Set `plugins.entries.xai.config.webSearch.baseUrl` when Grok web search should
route through an operator proxy or xAI-compatible Responses endpoint. OpenClaw
posts to `<baseUrl>/responses` after trimming trailing slashes. `x_search`
uses the same `webSearch.baseUrl` fallback unless
`plugins.entries.xai.config.xSearch.baseUrl` is set.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [x_search in Web Search](/tools/web#x_search) -- first-class X search via xAI
- [Gemini Search](/tools/gemini-search) -- AI-synthesized answers via Google grounding
