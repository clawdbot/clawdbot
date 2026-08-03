---
summary: "Parallel Search -- LLM-optimized dense excerpts from web sources"
read_when:
  - You want web search without an API key
  - You want Parallel's paid Search API
  - You want dense excerpts ranked for LLM context efficiency
title: "Parallel search"
---

The Parallel plugin provides two [Parallel](https://parallel.ai/) `web_search`
providers, both returning ranked, LLM-optimized excerpts from a web index
built for AI agents:

| Provider               | id              | Auth                                                                                       |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------ |
| Parallel Search (Free) | `parallel-free` | None -- Parallel's free [Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp) |
| Parallel Search        | `parallel`      | `PARALLEL_API_KEY` -- paid Search API, higher rate limits and objective tuning             |

Set `tools.web.search.provider` to `parallel-free` or `parallel` to select
one explicitly; neither is auto-detected.

<Note>
  Direct OpenAI Responses models (`api: "openai-responses"`, provider
  `openai`, official API base URL) use OpenAI's hosted native web search
  automatically when `tools.web.search.provider` is unset, empty, `"auto"`,
  or `"openai"` -- so they bypass Parallel by default. Set
  `tools.web.search.provider` to `parallel-free` or `parallel` to route them
  through Parallel instead. See [Web Search overview](/tools/web).
</Note>

## Install plugin

```bash
openclaw plugins install @openclaw/parallel-plugin
openclaw gateway restart
```

## API key (paid provider)

`parallel-free` needs no key but still must be selected explicitly. The paid
`parallel` provider needs an API key:

<Steps>
  <Step title="Create an account">
    Sign up at [platform.parallel.ai](https://platform.parallel.ai) and
    generate an API key from your dashboard.
  </Step>
  <Step title="Store the key">
    Set `PARALLEL_API_KEY` in the Gateway environment, or configure via:

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
      parallel: {
        config: {
          webSearch: {
            apiKey: "par-...", // optional if PARALLEL_API_KEY is set
            baseUrl: "https://api.parallel.ai", // optional; OpenClaw appends /v1/search
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        // "parallel-free" for the free Search MCP, or "parallel" for the
        // paid API-backed provider shown here.
        provider: "parallel",
      },
    },
  },
}
```

**Environment alternative:** set `PARALLEL_API_KEY` in the Gateway
environment. For a gateway install, put it in `~/.openclaw/.env`.

## Base URL override

Applies to the paid `parallel` provider only; `parallel-free` always uses
`https://search.parallel.ai/mcp` and ignores this setting.

Set `plugins.entries.parallel.config.webSearch.baseUrl` to route paid
requests through a compatible proxy or alternate endpoint (for example, the
Cloudflare AI Gateway). OpenClaw normalizes bare hosts by prepending
`https://` and appends `/v1/search` unless the path already ends there. The
resolved endpoint is part of the search cache key, so results from different
endpoints are never shared.

## Tool parameters

Both providers expose Parallel's native search shape so the model fills in a
natural-language goal plus a few short keyword queries -- the pairing
Parallel [recommends](https://docs.parallel.ai/search/best-practices) for
best results.

<ParamField path="objective" type="string" required>
Natural-language description of the underlying question or goal (max 5000
chars). Should be self-contained.
</ParamField>

<ParamField path="search_queries" type="string[]" required>
Concise keyword search queries, 3-6 words each (1-5 entries, max 200 chars
each). Provide 2-3 diverse queries for best results.
</ParamField>

<ParamField path="count" type="number">
Results to return (1-40).
</ParamField>

<ParamField path="session_id" type="string">
Optional Parallel session id from a previous result's `sessionId`. Pass it on
follow-up searches in the same task so Parallel groups related calls and
improves subsequent results. Max 1000 chars on `parallel`; the free
`parallel-free` Search MCP caps it at 100. An id past the limit is dropped
(paid) or a fresh one is minted (free).
</ParamField>

<ParamField path="client_model" type="string">
Optional identifier of the model making the call (e.g. `claude-opus-4-7`,
`gpt-5.6-sol`), max 100 chars. Lets Parallel tailor default settings for your
model's capabilities. Pass the exact active model slug; do not shorten to a
family alias.
</ParamField>

## Notes

- Parallel ranks and compresses results for LLM reasoning utility, not human
  click-through; expect dense excerpts per result rather than full-page
  content.
- Result excerpts come back as the `excerpts` array and are also joined into
  `description` for compatibility with the generic `web_search` contract.
- Both providers return a `session_id`; OpenClaw surfaces it as `sessionId` in
  the tool payload so callers can group follow-up searches. A
  Parallel-generated session id (one the caller did not supply) is excluded
  from the cache entry, since unrelated tasks with identical queries should
  not inherit it.
- `searchId`, `warnings`, and `usage` from Parallel are passed through when
  present.
- OpenClaw always forwards a resolved result count to Parallel as
  `advanced_settings.max_results` (`parallel`) or applies `count`
  client-side after Parallel's fixed-size response (`parallel-free`). The
  caller's `count` arg wins, then `tools.web.search.maxResults`, otherwise
  OpenClaw's generic `web_search` default (5) -- Parallel's own API defaults
  to 10.
- Results are cached for 15 minutes by default (`cacheTtlMinutes`).
- `parallel-free` mints a fresh `session_id` per call via its MCP handshake
  when the caller does not supply one; `parallel` leaves it unset in that
  case.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Exa search](/tools/exa-search) -- neural search with content extraction
- [Perplexity Search](/tools/perplexity-search) -- structured results with domain filtering
