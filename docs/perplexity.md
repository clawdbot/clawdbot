---
summary: "Perplexity Sonar setup for web_search"
read_when:
  - You want to use Perplexity Sonar for web search
  - You need PERPLEXITY_API_KEY or OpenRouter setup
---

# Perplexity Sonar

Moltbot can use Perplexity Sonar for the `web_search` tool. You can connect
through Perplexity’s direct API or via OpenRouter.

## API options

### Perplexity (direct)

- Base URL: https://api.perplexity.ai
- Environment variable: `PERPLEXITY_API_KEY`

### OpenRouter (alternative)

- Base URL: https://openrouter.ai/api/v1
- Environment variable: `OPENROUTER_API_KEY`
- Supports prepaid/crypto credits.

## Config example

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro"
        }
      }
    }
  }
}
```

## Switching from Brave

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai"
        }
      }
    }
  }
}
```

If both `PERPLEXITY_API_KEY` and `OPENROUTER_API_KEY` are set, set
`tools.web.search.perplexity.baseUrl` (or `tools.web.search.perplexity.apiKey`)
to disambiguate.

If no base URL is set, Moltbot chooses a default based on the API key source:

- `PERPLEXITY_API_KEY` or `pplx-...` → direct Perplexity (`https://api.perplexity.ai`)
- `OPENROUTER_API_KEY` or `sk-or-...` → OpenRouter (`https://openrouter.ai/api/v1`)
- Unknown key formats → OpenRouter (safe fallback)

## Models

- `perplexity/sonar` — fast Q&A with web search
- `perplexity/sonar-pro` (default) — multi-step reasoning + web search
- `perplexity/sonar-reasoning-pro` — deep research

See [Web tools](/tools/web) for the full web_search configuration.
