# @openclaw/zai-search-plugin

Official Z.AI Web Search provider plugin for Assistant.

## Overview

This plugin adds Z.AI as a `web_search` provider in Assistant. It uses the
[MCP web search endpoint](https://docs.z.ai/api-reference/tools/web-search)
at `https://api.z.ai/api/mcp/web_search_prime/mcp`, which is **included in the
GLM Coding Plan** — no separate billing or credits required beyond the coding
plan.

### How it works

The Z.AI MCP protocol requires two HTTP requests:

1. **Initialize** — `POST {baseUrl}` with `method: "initialize"` → returns a
   `Mcp-Session-Id` header
2. **Call tool** — `POST {baseUrl}` with `method: "tools/call"`,
   `name: "web_search_prime"`, and the session header → returns SSE-encoded
   JSON-RPC results

Each result contains `{ title, link, content, refer }`.

### Supported parameters

| Parameter  | Z.AI mapping                        |
|------------|-------------------------------------|
| `query`    | `search_query`                      |
| `count`    | Slices result array (1–10)          |
| `country`  | `location` (`cn` or `us`)           |
| `freshness`| `search_recency_filter` (oneDay/Week/Month/Year) |

## Install

```bash
openclaw plugins install @openclaw/zai-search-plugin
```

## Configuration

```json
{
  "plugins": {
    "entries": {
      "zai-search": {
        "enabled": true,
        "config": {
          "webSearch": {
            "apiKey": "***"
          }
        }
      }
    }
  }
}
```

The API key is the same Z.AI key used for model inference. It also falls back
to the `ZAI_API_KEY` / `Z_AI_API_KEY` environment variables.

### Selecting Z.AI as the search provider

```bash
openclaw config set tools.web.search.provider zai-search
```

Provider-specific options live under `plugins.entries.zai-search.config.webSearch.*`.

## Docs

- [Z.AI Web Search API](https://docs.z.ai/api-reference/tools/web-search)
- [Assistant Web Search](https://docs.openclaw.ai/tools/web-search)
