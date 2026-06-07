---
summary: "Parallel Search -- LLM-optimized dense excerpts from web sources"
read_when:
  - You want web search without an API key
  - You want Parallel's paid Search API
  - You want dense excerpts ranked for LLM context efficiency
title: "Parallel search"
---

OpenClaw bundles two [Parallel](https://parallel.ai/) `web_search` providers:

- **Parallel Search (Free)** (`parallel-free`) -- Parallel's free
  [Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp). Requires no
  account or API key. OpenClaw selects it automatically when no other web search
  provider is configured, so `web_search` works without setup.
- **Parallel Search** (`parallel`) -- Parallel's paid Search API. Requires a
  `PARALLEL_API_KEY` and offers higher rate limits and objective tuning.

Both return ranked, LLM-optimized excerpts from a web index built for AI agents.
Set `tools.web.search.provider` to `parallel-free` or `parallel` to choose one
explicitly.

<Note>
  OpenAI Responses models use OpenAI's native web search when
  `tools.web.search.provider` is unset, so they bypass the Parallel providers.
  Set `tools.web.search.provider` to `parallel-free` or `parallel` to route them
  through Parallel.
</Note>

## API key (paid provider)

`parallel-free` requires no setup. The paid `parallel` provider needs an API
key:

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
        provider: "parallel",
      },
    },
  },
}
```

**Environment alternative:** set `PARALLEL_API_KEY` in the Gateway environment.
For a gateway install, put it in `~/.openclaw/.env`.

## Base URL override

The base URL override applies to the paid `parallel` provider only. The free
`parallel-free` provider always uses `https://search.parallel.ai/mcp`.

Set `plugins.entries.parallel.config.webSearch.baseUrl` when Parallel requests
should go through a compatible proxy or alternate Parallel endpoint (for
example, the Cloudflare AI Gateway). OpenClaw normalizes bare hosts by
prepending `https://` and appends `/v1/search` unless the path already ends
there. The resolved endpoint is included in the search cache key, so results
from different Parallel endpoints are not shared.

## Tool parameters

OpenClaw exposes Parallel's native search shape so the model can fill in both
the natural-language goal and a few short keyword queries — the pairing
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
Optional Parallel session id (max 1000 chars on `parallel`; the free
`parallel-free` Search MCP caps it at 100). Pass the `sessionId` from a previous
Parallel result on follow-up searches that are part of the same task so Parallel
can group related calls and improve subsequent results. An id past the limit is
dropped and a fresh one is generated.
</ParamField>

<ParamField path="client_model" type="string">
Optional identifier of the model making the call (e.g. `claude-opus-4-7`,
`gpt-5.5`). Lets Parallel tailor default settings for your model's
capabilities. Pass the exact active model slug; do not shorten to a family
alias.
</ParamField>

## Notes

- Parallel ranks and compresses results based on LLM reasoning utility, not
  human click-through; expect dense excerpts in each result rather than
  full-page content
- Result excerpts come back as the `excerpts` array and are also joined into
  the `description` field for compatibility with the generic `web_search`
  contract
- Parallel returns a `session_id` on every response; OpenClaw surfaces it as
  `sessionId` in the tool payload so callers can group follow-up searches
- `searchId`, `warnings`, and `usage` from Parallel are passed through when
  present
- OpenClaw always forwards a resolved result count to Parallel as
  `advanced_settings.max_results`. The caller's `count` arg wins, then the
  top-level `tools.web.search.maxResults` setting, otherwise OpenClaw's
  generic `web_search` default (5). This keeps result volume consistent
  when switching between providers; Parallel on its own defaults to 10
- Results are cached for 15 minutes by default (configurable via
  `cacheTtlMinutes`)
- The free `parallel-free` provider accepts the same parameters. It applies
  `count` client-side and generates a `session_id` per call when one is not
  supplied.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Exa search](/tools/exa-search) -- neural search with content extraction
- [Perplexity Search](/tools/perplexity-search) -- structured results with domain filtering
