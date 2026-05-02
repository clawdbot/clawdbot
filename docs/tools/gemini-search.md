---
summary: "Gemini web search with Google Search grounding"
read_when:
  - You want to use Gemini for web_search
  - You need a GEMINI_API_KEY or models.providers.google.apiKey
  - You want Google Search grounding
title: "Gemini search"
---

OpenClaw supports Gemini models with built-in
[Google Search grounding](https://ai.google.dev/gemini-api/docs/grounding),
which returns AI-synthesized answers backed by live Google Search results with
citations.

## Get an API key

<Steps>
  <Step title="Create a key">
    Go to [Google AI Studio](https://aistudio.google.com/apikey) and create an
    API key.
  </Step>
  <Step title="Store the key">
    Set `GEMINI_API_KEY` in the Gateway environment, reuse
    `models.providers.google.apiKey`, or configure a dedicated web-search key via:

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
      google: {
        config: {
          webSearch: {
            apiKey: "AIza...", // optional if GEMINI_API_KEY or models.providers.google.apiKey is set
            baseUrl: "https://generativelanguage.googleapis.com/v1beta", // optional; falls back to models.providers.google.baseUrl
            model: "gemini-2.5-flash", // default
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "gemini",
      },
    },
  },
}
```

**Credential precedence:** Gemini web search uses
`plugins.entries.google.config.webSearch.apiKey` first, then `GEMINI_API_KEY`,
then `models.providers.google.apiKey`. For base URLs, the dedicated
`plugins.entries.google.config.webSearch.baseUrl` wins before
`models.providers.google.baseUrl`.

For a gateway install, put env keys in `~/.openclaw/.env`.

## How it works

Unlike traditional search providers that return a list of links and snippets,
Gemini uses Google Search grounding to produce AI-synthesized answers with
inline citations. The results include both the synthesized answer and the source
URLs.

- Citation URLs from Gemini grounding are automatically resolved from Google
  redirect URLs to direct URLs.
- Redirect resolution uses the SSRF guard path (HEAD + redirect checks +
  http/https validation) before returning the final citation URL.
- Redirect resolution uses strict SSRF defaults, so redirects to
  private/internal targets are blocked.

## Supported parameters

Gemini search supports `query`, `freshness`, `date_after`, and `date_before`.

`count` is accepted for shared `web_search` compatibility, but Gemini grounding
still returns one synthesized answer with citations rather than an N-result
list.

`freshness` accepts `day`, `week`, `month`, `year`, and the shared shortcuts
`pd`, `pw`, `pm`, and `py`. OpenClaw converts these values, or an explicit
`date_after`/`date_before` range, into Gemini Google Search grounding's
`timeRangeFilter`. `country`, `language`, and `domain_filter` are not supported.

## Model selection

The default model is `gemini-2.5-flash` (fast and cost-effective). Any Gemini
model that supports grounding can be used via
`plugins.entries.google.config.webSearch.model`.

## Base URL overrides

Set `plugins.entries.google.config.webSearch.baseUrl` when Gemini web search
must route through an operator proxy or custom Gemini-compatible endpoint. If
that is unset, Gemini web search reuses `models.providers.google.baseUrl`. A plain
`https://generativelanguage.googleapis.com` value is normalized to
`https://generativelanguage.googleapis.com/v1beta`; custom proxy paths are kept
as provided after trimming trailing slashes.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Brave Search](/tools/brave-search) -- structured results with snippets
- [Perplexity Search](/tools/perplexity-search) -- structured results + content extraction
