---
summary: "SenseAudio web search via the SenseAudio Responses API"
read_when:
  - You want to use SenseAudio for web_search
  - You need a SENSEAUDIO_API_KEY
title: "SenseAudio search"
---

OpenClaw supports SenseAudio as a `web_search` provider, using the SenseAudio
Responses API with native `web_search` grounding to produce AI-synthesized
answers with citations.

## Get an API key

<Steps>
  <Step title="Create a key">
    Get an API key from [SenseAudio](https://senseaudio.cn/).
  </Step>
  <Step title="Store the key">
    Set `SENSEAUDIO_API_KEY` in the Gateway environment, or configure via:

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
      senseaudio: {
        config: {
          webSearch: {
            apiKey: "sk-...", // optional if SENSEAUDIO_API_KEY is set
            baseUrl: "https://api.senseaudio.cn/v1",
            model: "senseaudio-s2",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "senseaudio",
      },
    },
  },
}
```

**Environment alternative:** set `SENSEAUDIO_API_KEY` in the Gateway
environment. For a gateway install, put it in `~/.openclaw/.env`.

If you omit `baseUrl`, OpenClaw defaults to `https://api.senseaudio.cn/v1`.
If you omit `model`, OpenClaw defaults to `senseaudio-s2`.

### Custom endpoints

If you point `baseUrl` at a private or loopback host (for example an internal
gateway such as `http://127.0.0.1:3210/v1`), OpenClaw treats the explicit
configuration as operator opt-in and uses the self-hosted network policy for
that endpoint. Custom public endpoints must use `https://`; cleartext
`http://` is only allowed for private and loopback targets.

## How it works

OpenClaw sends one non-streaming request to the SenseAudio `/responses`
endpoint with the hosted `web_search` tool forced through `tool_choice`, so
SenseAudio searches before it answers. Search queries are sent with
`store: false`.

Citations come from the returned `web_search_call` source URLs, plus inline
`url_citation` annotations when present. OpenClaw treats SenseAudio
`web_search` as successful only when the response carries native web-search
grounding evidence. If SenseAudio answers without any search call or citations,
OpenClaw returns a structured `senseaudio_web_search_ungrounded` error instead
of wrapping that text as a search result. Retry the query, switch to a
structured provider such as Brave, or use `web_fetch` / the browser tool when
you already have a target URL.

## Supported parameters

SenseAudio search supports `query`. SenseAudio returns one synthesized answer
with citations rather than an N-result list, so there is no `count` parameter.

Provider-specific filters (country, language, freshness, date ranges) are not
supported.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Gemini Search](/tools/gemini-search) -- AI-synthesized answers via Google grounding
- [Grok Search](/tools/grok-search) -- AI-synthesized answers via xAI grounding
- [Kimi Search](/tools/kimi-search) -- AI-synthesized answers via Moonshot web search
