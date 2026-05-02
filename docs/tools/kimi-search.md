---
summary: "Kimi web search via Moonshot web search"
read_when:
  - You want to use Kimi for web_search
  - You need a KIMI_API_KEY or MOONSHOT_API_KEY
title: "Kimi search"
---

OpenClaw supports Kimi as a `web_search` provider, using Moonshot web search
to produce AI-synthesized answers with citations.

## Get an API key

<Steps>
  <Step title="Create a key">
    Get an API key from [Moonshot AI](https://platform.moonshot.cn/).
  </Step>
  <Step title="Store the key">
    Set `KIMI_API_KEY` or `MOONSHOT_API_KEY` in the Gateway environment, or
    configure via:

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

When you choose **Kimi** during `openclaw onboard` or
`openclaw configure --section web`, OpenClaw can also ask for:

- the Moonshot API region:
  - `https://api.moonshot.ai/v1`
  - `https://api.moonshot.cn/v1`
- the default Kimi web-search model (defaults to `kimi-k2.6`)

## Config

```json5
{
  plugins: {
    entries: {
      moonshot: {
        config: {
          webSearch: {
            apiKey: "sk-...", // optional if KIMI_API_KEY or MOONSHOT_API_KEY is set
            baseUrl: "https://api.moonshot.ai/v1",
            model: "kimi-k2.6",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "kimi",
      },
    },
  },
}
```

If you use the China API host for chat (`models.providers.moonshot.baseUrl`:
`https://api.moonshot.cn/v1`), OpenClaw reuses that same host for Kimi
`web_search` when `tools.web.search.kimi.baseUrl` is omitted, so keys from
[platform.moonshot.cn](https://platform.moonshot.cn/) do not hit the
international endpoint by mistake (which often returns HTTP 401). Override
with `tools.web.search.kimi.baseUrl` when you need a different search base URL.

**Environment alternative:** set `KIMI_API_KEY` or `MOONSHOT_API_KEY` in the
Gateway environment. For a gateway install, put it in `~/.openclaw/.env`.

If you omit `baseUrl`, OpenClaw defaults to `https://api.moonshot.ai/v1`.
If you omit `model`, OpenClaw defaults to `kimi-k2.6`.

## How it works

Kimi uses Moonshot web search to synthesize answers with inline citations,
similar to Gemini and Grok's grounded response approach.

OpenClaw treats Kimi `web_search` as successful only after Moonshot returns
native web-search grounding evidence, such as a replayable `$web_search` tool
payload, `search_results`, or citation URLs. If Kimi stops immediately with a
plain chat answer like "I cannot browse the internet" and no grounding evidence,
OpenClaw returns a structured `kimi_web_search_ungrounded` error instead of
wrapping that text as a search result. Retry the query, switch to a structured
provider such as Brave, or use `web_fetch` / the browser tool when you already
have a target URL.

## Supported parameters

Kimi search supports `query`.

`count` is accepted for shared `web_search` compatibility, but Kimi still
returns one synthesized answer with citations rather than an N-result list.

Provider-specific filters are not currently supported.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Moonshot AI](/providers/moonshot) -- Moonshot model + Kimi Coding provider docs
- [Gemini Search](/tools/gemini-search) -- AI-synthesized answers via Google grounding
- [Grok Search](/tools/grok-search) -- AI-synthesized answers via xAI grounding
