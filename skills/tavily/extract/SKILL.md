---
name: extract
description: "Extract content from specific URLs using Tavily's extraction API. Returns clean markdown/text from web pages. Use when you have specific URLs and need their content without writing code."
---

# Extract Skill

Extract clean content from specific URLs. Ideal when you know which pages you want content from.

## Prerequisites

**Tavily API Key Required** - Get your key at https://tavily.com

Add to `~/.claude/settings.json`:
```json
{
  "env": {
    "TAVILY_API_KEY": "tvly-your-api-key-here"
  }
}
```

## Quick Start

### Using the Script

```bash
./scripts/extract.sh '<json>'
```

**Examples:**
```bash
# Single URL
./scripts/extract.sh '{"urls": ["https://example.com/article"]}'

# Multiple URLs
./scripts/extract.sh '{"urls": ["https://example.com/page1", "https://example.com/page2"]}'

# With query focus and chunks
./scripts/extract.sh '{"urls": ["https://example.com/docs"], "query": "authentication API", "chunks_per_source": 3}'

# Advanced extraction for JS pages
./scripts/extract.sh '{"urls": ["https://app.example.com"], "extract_depth": "advanced", "timeout": 60}'
```

### Basic Extraction

```bash
curl --request POST \
  --url https://api.tavily.com/extract \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "urls": ["https://example.com/article"]
  }'
```

### Multiple URLs with Query Focus

```bash
curl --request POST \
  --url https://api.tavily.com/extract \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "urls": [
      "https://example.com/ml-healthcare",
      "https://example.com/ai-diagnostics"
    ],
    "query": "AI diagnostic tools accuracy",
    "chunks_per_source": 3
  }'
```

## API Reference

### Endpoint

```
POST https://api.tavily.com/extract
```

### Headers

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <TAVILY_API_KEY>` |
| `Content-Type` | `application/json` |

### Request Body

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `urls` | array | Required | URLs to extract (max 20) |
| `query` | string | null | Reranks chunks by relevance |
| `chunks_per_source` | integer | 3 | Chunks per URL (1-5, requires query) |
| `extract_depth` | string | `"basic"` | `basic` or `advanced` (for JS pages) |
| `format` | string | `"markdown"` | `markdown` or `text` |
| `include_images` | boolean | false | Include image URLs |
| `timeout` | float | varies | Max wait (1-60 seconds) |

### Response Format

```json
{
  "results": [
    {
      "url": "https://example.com/article",
      "raw_content": "# Article Title\n\nContent..."
    }
  ],
  "failed_results": [],
  "response_time": 2.3
}
```

## Extract Depth

| Depth | When to Use |
|-------|-------------|
| `basic` | Simple text extraction, faster |
| `advanced` | Dynamic/JS-rendered pages, tables, structured data |

## Examples

### Single URL Extraction

```bash
curl --request POST \
  --url https://api.tavily.com/extract \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "urls": ["https://docs.python.org/3/tutorial/classes.html"],
    "extract_depth": "basic"
  }'
```

### Targeted Extraction with Query

```bash
curl --request POST \
  --url https://api.tavily.com/extract \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "urls": [
      "https://example.com/react-hooks",
      "https://example.com/react-state"
    ],
    "query": "useState and useEffect patterns",
    "chunks_per_source": 2
  }'
```

### JavaScript-Heavy Pages

```bash
curl --request POST \
  --url https://api.tavily.com/extract \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "urls": ["https://app.example.com/dashboard"],
    "extract_depth": "advanced",
    "timeout": 60
  }'
```

### Batch Extraction

```bash
curl --request POST \
  --url https://api.tavily.com/extract \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "urls": [
      "https://example.com/page1",
      "https://example.com/page2",
      "https://example.com/page3",
      "https://example.com/page4",
      "https://example.com/page5"
    ],
    "extract_depth": "basic"
  }'
```

## Tips

- **Max 20 URLs per request** - batch larger lists
- **Use `query` + `chunks_per_source`** to get only relevant content
- **Try `basic` first**, fall back to `advanced` if content is missing
- **Set longer `timeout`** for slow pages (up to 60s)
- **Check `failed_results`** for URLs that couldn't be extracted
