---
name: crawl
description: "Crawl any website and save pages as local markdown files. Use when you need to download documentation, knowledge bases, or web content for offline access or analysis. No code required - just provide a URL."
---

# Crawl Skill

Crawl websites to extract content from multiple pages. Ideal for documentation, knowledge bases, and site-wide content extraction.

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
./scripts/crawl.sh '<json>' [output_dir]
```

**Examples:**
```bash
# Basic crawl
./scripts/crawl.sh '{"url": "https://docs.example.com"}'

# Deeper crawl with limits
./scripts/crawl.sh '{"url": "https://docs.example.com", "max_depth": 2, "limit": 50}'

# Save to files
./scripts/crawl.sh '{"url": "https://docs.example.com", "max_depth": 2}' ./docs

# Focused crawl with path filters
./scripts/crawl.sh '{"url": "https://example.com", "max_depth": 2, "select_paths": ["/docs/.*", "/api/.*"], "exclude_paths": ["/blog/.*"]}'

# With semantic instructions (for agentic use)
./scripts/crawl.sh '{"url": "https://docs.example.com", "instructions": "Find API documentation", "chunks_per_source": 3}'
```

When `output_dir` is provided, each crawled page is saved as a separate markdown file.

### Basic Crawl

```bash
curl --request POST \
  --url https://api.tavily.com/crawl \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "url": "https://docs.example.com",
    "max_depth": 1,
    "limit": 20
  }'
```

### Focused Crawl with Instructions

```bash
curl --request POST \
  --url https://api.tavily.com/crawl \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "url": "https://docs.example.com",
    "max_depth": 2,
    "instructions": "Find API documentation and code examples",
    "chunks_per_source": 3,
    "select_paths": ["/docs/.*", "/api/.*"]
  }'
```

## API Reference

### Endpoint

```
POST https://api.tavily.com/crawl
```

### Headers

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer <TAVILY_API_KEY>` |
| `Content-Type` | `application/json` |

### Request Body

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | Required | Root URL to begin crawling |
| `max_depth` | integer | 1 | Levels deep to crawl (1-5) |
| `max_breadth` | integer | 20 | Links per page |
| `limit` | integer | 50 | Total pages cap |
| `instructions` | string | null | Natural language guidance for focus |
| `chunks_per_source` | integer | 3 | Chunks per page (1-5, requires instructions) |
| `extract_depth` | string | `"basic"` | `basic` or `advanced` |
| `format` | string | `"markdown"` | `markdown` or `text` |
| `select_paths` | array | null | Regex patterns to include |
| `exclude_paths` | array | null | Regex patterns to exclude |
| `allow_external` | boolean | true | Include external domain links |
| `timeout` | float | 150 | Max wait (10-150 seconds) |

### Response Format

```json
{
  "base_url": "https://docs.example.com",
  "results": [
    {
      "url": "https://docs.example.com/page",
      "raw_content": "# Page Title\n\nContent..."
    }
  ],
  "response_time": 12.5
}
```

## Depth vs Performance

| Depth | Typical Pages | Time |
|-------|---------------|------|
| 1 | 10-50 | Seconds |
| 2 | 50-500 | Minutes |
| 3 | 500-5000 | Many minutes |

**Start with `max_depth=1`** and increase only if needed.

## Crawl for Context vs Data Collection

**For agentic use (feeding results into context):** Always use `instructions` + `chunks_per_source`. This returns only relevant chunks instead of full pages, preventing context window explosion.

**For data collection (saving to files):** Omit `chunks_per_source` to get full page content.

## Examples

### For Context: Agentic Research (Recommended)

Use when feeding crawl results into an LLM context:

```bash
curl --request POST \
  --url https://api.tavily.com/crawl \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "url": "https://docs.example.com",
    "max_depth": 2,
    "instructions": "Find API documentation and authentication guides",
    "chunks_per_source": 3
  }'
```

Returns only the most relevant chunks (max 500 chars each) per page - fits in context without overwhelming it.

### For Context: Targeted Technical Docs

```bash
curl --request POST \
  --url https://api.tavily.com/crawl \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "url": "https://example.com",
    "max_depth": 2,
    "instructions": "Find all documentation about authentication and security",
    "chunks_per_source": 3,
    "select_paths": ["/docs/.*", "/api/.*"]
  }'
```

### For Data Collection: Full Page Archive

Use when saving content to files for later processing:

```bash
curl --request POST \
  --url https://api.tavily.com/crawl \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "url": "https://example.com/blog",
    "max_depth": 2,
    "max_breadth": 50,
    "select_paths": ["/blog/.*"],
    "exclude_paths": ["/blog/tag/.*", "/blog/category/.*"]
  }'
```

Returns full page content - use the script with `output_dir` to save as markdown files.

## Map API (URL Discovery)

Use `map` instead of `crawl` when you only need URLs, not content:

```bash
curl --request POST \
  --url https://api.tavily.com/map \
  --header "Authorization: Bearer $TAVILY_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{
    "url": "https://docs.example.com",
    "max_depth": 2,
    "instructions": "Find all API docs and guides"
  }'
```

Returns URLs only (faster than crawl):

```json
{
  "base_url": "https://docs.example.com",
  "results": [
    "https://docs.example.com/api/auth",
    "https://docs.example.com/guides/quickstart"
  ]
}
```

## Tips

- **Always use `chunks_per_source` for agentic workflows** - prevents context explosion when feeding results to LLMs
- **Omit `chunks_per_source` only for data collection** - when saving full pages to files
- **Start conservative** (`max_depth=1`, `limit=20`) and scale up
- **Use path patterns** to focus on relevant sections
- **Use Map first** to understand site structure before full crawl
- **Always set a `limit`** to prevent runaway crawls
