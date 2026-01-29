---
summary: "Jina Reader fallback for web_fetch (PDF support + browser rendering)"
read_when:
  - You want Jina-backed web extraction
  - You need a Jina API key
  - You want PDF extraction for web_fetch
  - You want browser-rendered extraction for JS-heavy sites
---

# Jina Reader

Moltbot can use **Jina Reader** as a fallback extractor for `web_fetch`. It is a
content extraction service optimised for LLM consumption, with excellent PDF support
and optional browser rendering for JavaScript-heavy sites.

## Get an API key

1) Sign up at https://jina.ai/?sui=apikey (10M free tokens included)
2) Store it in config or set `JINA_API_KEY` in the gateway environment.

## Configure Jina

```json5
{
  tools: {
    web: {
      fetch: {
        jina: {
          apiKey: "JINA_API_KEY_HERE",
          baseUrl: "https://r.jina.ai",
          engine: "browser",
          timeoutSeconds: 30
        }
      }
    }
  }
}
```

Notes:
- `jina.enabled` defaults to true when an API key is present.
- `engine` can be "browser" (quality), "direct" (speed), or "cf-browser-rendering" (JS-heavy).

## Engine Options

| Engine | Best For | Speed |
|--------|----------|-------|
| `direct` | Simple HTML pages | Fastest |
| `browser` | Most pages (default) | Medium |
| `cf-browser-rendering` | JS-heavy SPAs | Slowest |

## Additional Options

| Option | Description |
|--------|-------------|
| `noCache` | Bypass Jina's cache for fresh content |
| `withLinksSummary` | Include a summary of all links at end of content |
| `withImagesSummary` | Include a summary of all images at end of content |
| `returnFormat` | Output format: "markdown", "text", or "html" |

## How `web_fetch` uses Jina

`web_fetch` extraction order:
1) Readability (local)
2) **Jina** (if configured)
3) Firecrawl (if configured)
4) Basic HTML cleanup (last fallback)

Jina is tried before Firecrawl because:
- Token-based pricing is more affordable for high-volume use
- Better PDF extraction support
- No anti-bot circumvention overhead

See [Web tools](/tools/web) for the full web tool setup.

## Comparison with Firecrawl

| Feature | Jina | Firecrawl |
|---------|------|-----------|
| **Pricing** | Token-based (10M free) | Credit-based |
| **PDF Support** | Excellent | Basic |
| **Image Captioning** | Yes (via VLM) | No |
| **Anti-bot Bypass** | No | Yes (stealth proxy) |
| **JS Rendering** | Yes (browser engine) | Yes |

**Recommendation:** Use Jina for most use cases; add Firecrawl if you frequently
hit bot detection on specific sites.

## Environment Variables

- `JINA_API_KEY` - API key for Jina Reader (fallback when not set in config)

## Rate Limits

| Tier | RPM |
|------|-----|
| No API Key | 20 |
| Free API Key | 500 |
| Premium | 5,000 |

## Pricing

Jina uses token-based pricing:
- **Free tier**: 10 million tokens included
- **Paid**: ~$0.02 per 1M tokens (varies by plan)

This is typically more cost-effective than Firecrawl's credit-based model for
high-volume extraction.
