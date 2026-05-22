---
summary: "Adds memory embedding provider support."
read_when:
  - You are installing, configuring, or auditing the voyage plugin
title: "Voyage plugin"
---

# Voyage plugin

Adds memory embedding provider support.

## Setup

Voyage is a remote memory embedding provider, so it needs a Voyage API key before
memory search can use it.

Set the key with either:

- Environment variable: `VOYAGE_API_KEY`
- Config key: `models.providers.voyage.apiKey`

For an interactive setup, run:

```bash
openclaw configure --section model
```

To make memory search use Voyage explicitly, set the memory search provider to
`voyage` and choose a Voyage embedding model:

```ts
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "voyage",
        model: "voyage-3-large",
      },
    },
  },
  models: {
    providers: {
      voyage: {
        apiKey: "${VOYAGE_API_KEY}",
      },
    },
  },
}
```

Verify the runtime credential and embedding provider path with:

```bash
openclaw memory status --deep
```

For the full memory embedding provider matrix and API key resolution order, see
[Memory config](/reference/memory-config).

## Distribution

- Package: `@openclaw/voyage-provider`
- Install route: included in OpenClaw

## Surface

contracts: memoryEmbeddingProviders
