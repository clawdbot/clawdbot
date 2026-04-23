---
summary: "MiniMax Search via the Coding Plan search API"
read_when:
  - You want to use MiniMax for web_search
  - You need a MiniMax Coding Plan key
  - You want MiniMax CN/global search host guidance
title: "MiniMax search"
---

OpenClaw supports MiniMax as a `web_search` provider through the MiniMax
Coding Plan search API. It returns structured search results with titles, URLs,
snippets, and related queries.

## Get a Coding Plan key

<Steps>
  <Step title="Create a key">
    Create or copy a MiniMax Coding Plan key from
    [MiniMax Platform](https://platform.minimax.io/user-center/basic-information/interface-key).
  </Step>
  <Step title="Store the key">
    Set `MINIMAX_CODE_PLAN_KEY` in the Gateway environment, or configure via:

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

OpenClaw also accepts `MINIMAX_CODING_API_KEY` as an env alias. `MINIMAX_API_KEY`
is still read as a compatibility fallback when it already points at a coding-plan token.

## Config

```json5
{
  plugins: {
    entries: {
      minimax: {
        config: {
          webSearch: {
            apiKey: "sk-cp-...", // optional if MINIMAX_CODE_PLAN_KEY is set
            region: "global", // or "cn"
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "minimax",
      },
    },
  },
}
```

**Environment alternative:** set `MINIMAX_CODE_PLAN_KEY` in the Gateway environment.
For a gateway install, put it in `~/.openclaw/.env`.

## Region selection

MiniMax Search uses these endpoints:

- Global: `https://api.minimax.io/v1/coding_plan/search`
- CN: `https://api.minimaxi.com/v1/coding_plan/search`

If `plugins.entries.minimax.config.webSearch.region` is unset, OpenClaw resolves
the region in this order:

1. `tools.web.search.minimax.region` / plugin-owned `webSearch.region`
2. `MINIMAX_API_HOST`
3. `models.providers.minimax.baseUrl`
4. `models.providers.minimax-portal.baseUrl`

That means CN onboarding or `MINIMAX_API_HOST=https://api.minimaxi.com/...`
automatically keeps MiniMax Search on the CN host too.

Even when you authenticated MiniMax through the OAuth `minimax-portal` path,
web search still registers as provider id `minimax`; the OAuth provider base URL
is only used as a region hint for CN/global host selection.

## Supported parameters

MiniMax Search supports:

- `query`
- `count` (OpenClaw trims the returned result list to the requested count)

Provider-specific filters are not currently supported.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [MiniMax](/providers/minimax) -- model, image, speech, and auth setup
