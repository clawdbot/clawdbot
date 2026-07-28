---
summary: "Ollama Web Search via a local Ollama host or the hosted Ollama API"
read_when:
  - You want to use Ollama for web_search
  - You want a key-free web_search provider
  - You want to use hosted Ollama Web Search with OLLAMA_API_KEY
  - You need Ollama Web Search setup guidance
title: "Ollama web search"
---

OpenClaw supports **Ollama Web Search** as a bundled `web_search` provider,
returning titles, URLs, and snippets from Ollama's web-search API.

Local/self-hosted Ollama needs no API key by default; it requires a reachable
Ollama host plus `ollama signin`. Direct hosted search (no local Ollama) needs
`baseUrl: "https://ollama.com"` and a real `OLLAMA_API_KEY`.

## Setup

<Steps>
  <Step title="Start Ollama">
    Make sure Ollama is installed and running.
  </Step>
  <Step title="Sign in">
    ```bash
    ollama signin
    ```
  </Step>
  <Step title="Choose Ollama Web Search">
    ```bash
    openclaw configure --section web
    ```

    Select **Ollama Web Search** as the provider.

  </Step>
</Steps>

If you already use Ollama for models, Ollama Web Search reuses the same
configured host.

<Note>
  OpenClaw never auto-selects Ollama Web Search over a higher-priority
  credentialed provider; you must choose it explicitly with
  `tools.web.search.provider: "ollama"`.
</Note>

## Config

```json5
{
  tools: {
    web: {
      search: {
        provider: "ollama",
      },
    },
  },
}
```

Optional host override, scoped to web search only:

```json5
{
  plugins: {
    entries: {
      ollama: {
        config: {
          webSearch: {
            baseUrl: "http://ollama-host:11434",
          },
        },
      },
    },
  },
}
```

Or reuse the host already configured for the Ollama model provider:

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434",
      },
    },
  },
}
```

`models.providers.ollama.baseUrl` is the canonical key; the web-search
provider also accepts `baseURL` there for compatibility with OpenAI SDK-style
config examples. If nothing is set, OpenClaw defaults to
`http://127.0.0.1:11434`.

Direct hosted Ollama Web Search (no local Ollama):

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "https://ollama.com",
        apiKey: "OLLAMA_API_KEY",
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "ollama",
      },
    },
  },
}
```

## Auth and request routing

- No web-search-specific API key field exists; the provider reuses
  `models.providers.ollama.apiKey` (or the matching env-backed provider auth)
  when the configured host is auth-protected.
- Host resolution order: `plugins.entries.ollama.config.webSearch.baseUrl` →
  `models.providers.ollama.baseUrl` (or `baseURL`) → `http://127.0.0.1:11434`.
- If the resolved host is `https://ollama.com`, OpenClaw calls
  `https://ollama.com/api/web_search` directly with the API key as bearer
  auth.
- Otherwise OpenClaw calls the local proxy endpoint
  `/api/experimental/web_search` first (which signs and forwards to Ollama
  Cloud), then falls back to `/api/web_search` on the same host. If both fail
  and `OLLAMA_API_KEY` is set, it retries once against
  `https://ollama.com/api/web_search` with that key — without sending it to
  the local host.
- OpenClaw warns during setup if Ollama is unreachable or not signed in, but
  does not block selecting the provider.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Ollama](/providers/ollama) -- Ollama model setup and cloud/local modes
