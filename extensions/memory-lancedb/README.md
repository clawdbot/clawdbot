# Memory (LanceDB) Extension

LanceDB-backed long-term memory with semantic search.

## Venice Embeddings (New!)

Uncensored embeddings w/o OpenAI key:

```json
{
  "extensions": {
    "memory-lancedb": {
      "embedding": {
        "provider": "venice",
        "model": "text-embedding-bge-m3",
        "apiKey": "VENICE-INFERENCE-KEY-...",
        "baseUrl": "https://api.venice.ai/api/v1"
      },
      "autoCapture": true,
      "autoRecall": true
    }
  }
}
```

- **Model**: text-embedding-bge-m3 (1024 dims)
- **Compatible**: OpenAI client proxy
- **Fallback**: OpenAI text-embedding-3-small/large

## Setup

1. Add to Clawdbot config.
2. `clawdbot gateway restart`
3. Use `memory_search "query"` – works!

## Tools

- `memory_search`: Semantic recall from MEMORY.md + memory/*.md
- `memory_get`: Snippet read
- Auto-capture/recall on conversations

Tested Venice API response.