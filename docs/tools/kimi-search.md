---
summary: "Kimi web search via Moonshot web search"
read_when:
  - You want to use Kimi for web_search
  - You need a KIMI_API_KEY or MOONSHOT_API_KEY
title: "Kimi search"
---

Kimi is a `web_search` provider backed by Moonshot's native web search. Moonshot
synthesizes one answer with inline citations, similar to Gemini and Grok's
grounded-response providers, rather than returning a ranked result list.

## Setup

<Steps>
  <Step title="Create a key">
    Get an API key from [Moonshot AI](https://platform.moonshot.cn/).
  </Step>
  <Step title="Store the key">
    Set `KIMI_API_KEY` or `MOONSHOT_API_KEY` in the Gateway environment (for a
    gateway install, add it to `~/.openclaw/.env`), or configure via:

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

Choosing **Kimi** during `openclaw onboard` or `openclaw configure --section web`
also prompts for:

- the Moonshot API region: `https://api.moonshot.ai/v1` or `https://api.moonshot.cn/v1`
- the web-search model (defaults to `kimi-k2.6`)

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

`tools.web.search.provider` is auto-detected from available API keys when omitted;
set it to `kimi` explicitly if multiple search credentials are configured.

Configure Kimi-specific `apiKey`, `baseUrl`, and `model` values under
`plugins.entries.moonshot.config.webSearch`.

Defaults: `baseUrl` defaults to `https://api.moonshot.ai/v1` when omitted, `model`
defaults to `kimi-k2.6`.

If chat traffic uses the China host (`models.providers.moonshot.baseUrl`:
`https://api.moonshot.cn/v1`), Kimi `web_search` reuses that host automatically
when its own `baseUrl` is unset, so `.cn` keys do not accidentally hit the
international endpoint (which returns HTTP 401 for those keys). Set an explicit
Kimi `baseUrl` to override this inheritance.

## Grounding requirement

OpenClaw only returns a Kimi `web_search` result after Moonshot's response
includes native web-search grounding evidence, such as a `$web_search` tool-call
replay, `search_results`, or citation URLs. If Kimi answers directly with no
grounding (for example "I cannot browse the internet"), OpenClaw returns a
`kimi_web_search_ungrounded` error instead of treating that text as a search
result. Retry the query, switch to a structured provider such as Brave, or use
`web_fetch` / the browser tool when you already have a target URL.

## Tool parameters

| Parameter                                                       | Supported                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `query`                                                         | Yes                                                                                                                      |
| `count`                                                         | Accepted for cross-provider compatibility, but ignored: Kimi always returns one synthesized answer, not an N-result list |
| `country`, `language`, `freshness`, `date_after`, `date_before` | No                                                                                                                       |

## Related

- [Web Search overview](/tools/web) - all providers and auto-detection
- [Moonshot AI](/providers/moonshot) - Moonshot model + Kimi Coding provider docs
- [Gemini Search](/tools/gemini-search) - AI-synthesized answers via Google grounding
- [Grok Search](/tools/grok-search) - AI-synthesized answers via xAI grounding
