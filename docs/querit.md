---
summary: "Querit API setup for web_search"
read_when:
  - You want to use Querit for web_search
  - You need a QUERIT_API_KEY or plan details
---

# Querit

Moltbot supports Querit as an alternative provider for `web_search`.

## Get an API key

1) Create a Querit account at https://querit.ai/
2) Generate an API key in your account dashboard.
3) Store the key in config (recommended) or set `QUERIT_API_KEY` in the Gateway environment.

## Config example

```json5
{
  tools: {
    web: {
      search: {
        provider: "querit",
        querit: {
          apiKey: "QUERIT_API_KEY_HERE"
        },
        maxResults: 5,
        timeoutSeconds: 30
      }
    }
  }
}
```

## Notes

- Querit provides fast web search with structured results (title, URL, snippet).
- Check the Querit API portal for current limits and pricing.

See [Web tools](/tools/web) for full web_search configuration.
