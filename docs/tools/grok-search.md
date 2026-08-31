---
summary: "Grok web search via xAI web-grounded responses"
read_when:
  - You want to use Grok for web_search
  - You want to use xAI OAuth or an XAI_API_KEY for web search
title: "Grok search"
---

OpenClaw supports Grok as a `web_search` provider, using xAI web-grounded
responses to produce AI-synthesized answers backed by live search results
with citations.

Grok web search prefers an existing xAI OAuth sign-in when one is available.
If no OAuth profile exists, the same xAI API key also powers the built-in
`x_search` tool for X (formerly Twitter) post search and the `code_execution`
tool. Storing the key at `plugins.entries.xai.config.webSearch.apiKey` also
lets OpenClaw reuse it as a fallback for the bundled xAI model provider.

For post-level X metrics (reposts, replies, bookmarks, views), use
[`x_search`](/tools/web#x_search) with the exact post URL or status ID
instead of a broad search query.

## Onboarding and configure

Choosing **Grok** during `openclaw onboard` or `openclaw configure --section
web` lets OpenClaw reuse an existing xAI OAuth profile without prompting for
a separate web-search key. Without OAuth, it falls back to xAI API-key setup.

OpenClaw then offers a follow-up step to enable `x_search` with the same xAI
credential. That follow-up:

- only appears after you choose Grok for `web_search`
- is not a separate top-level web-search provider choice
- can optionally set the `x_search` model in the same flow

Skip it to enable or change `x_search` later in config.

## Sign in or get an API key

<Steps>
  <Step title="Use xAI OAuth">
    If you already signed in with xAI during onboarding or model auth, choose
    Grok as the `web_search` provider. No separate API key is required:

    ```bash
    openclaw onboard --auth-choice xai-oauth
    openclaw config set tools.web.search.provider grok
    ```

  </Step>
  <Step title="Use an API key fallback">
    Get an API key from [xAI](https://console.x.ai/) when OAuth is unavailable
    or you intentionally want key-backed web-search config.
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
            apiKey: "xai-...", // optional if xAI OAuth or XAI_API_KEY is available
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

**Credential alternatives:** `openclaw models auth login --provider xai
--method oauth`, `XAI_API_KEY` in the Gateway environment, or
`plugins.entries.xai.config.webSearch.apiKey`. For a gateway install, put env
vars in `~/.openclaw/.env`.

## How it works

Grok uses xAI web-grounded responses to synthesize answers with inline
citations, similar to Gemini's Google Search grounding approach.

## Supported parameters

Grok search supports `query`. `count` is accepted for shared `web_search`
compatibility, but Grok always returns one synthesized answer with citations
rather than an N-result list. Provider-specific filters are not supported.

Grok defaults to a 60 second timeout because xAI Responses web-grounded
searches can run longer than the shared `web_search` default. Override it
with `tools.web.search.timeoutSeconds`.

## Base URL overrides

Set `plugins.entries.xai.config.webSearch.baseUrl` to route Grok web search
through an operator proxy or xAI-compatible Responses endpoint. OpenClaw
posts to `<baseUrl>/responses` after trimming trailing slashes. `x_search`
falls back to the same `webSearch.baseUrl` unless
`plugins.entries.xai.config.xSearch.baseUrl` is set.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [x_search in Web Search](/tools/web#x_search) -- first-class X search via xAI
- [Gemini Search](/tools/gemini-search) -- AI-synthesized answers via Google grounding
