---
summary: "Parallel Search -- LLM-optimized dense excerpts from web sources"
read_when:
  - You want to use Parallel for web_search
  - You need a PARALLEL_API_KEY
  - You want dense excerpts ranked for LLM context efficiency
title: "Parallel search"
---

OpenClaw supports [Parallel](https://parallel.ai/) as a `web_search` provider.
Parallel returns ranked, LLM-optimized dense excerpts from a web index
purpose-built for AI agents.

## Get an API key

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
Optional Parallel session id (max 1000 chars). Pass the `sessionId` from a
previous Parallel result on follow-up searches that are part of the same task
so Parallel can group related calls and improve subsequent results.
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

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Exa search](/tools/exa-search) -- neural search with content extraction
- [Perplexity Search](/tools/perplexity-search) -- structured results with domain filtering
