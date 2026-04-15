---
name: tavily
description: Tavily web search, content extraction, and research tools.
metadata:
  { "openclaw": { "emoji": "🔍", "requires": { "config": ["plugins.entries.tavily.enabled"] } } }
---

# Tavily Tools

## When to use which tool

| Need                         | Tool             | When                                                          |
| ---------------------------- | ---------------- | ------------------------------------------------------------- |
| Quick web search             | `web_search`     | Basic queries, no special options needed                      |
| Search with advanced options | `tavily_search`  | Need depth, topic, domain filters, time ranges, or AI answers |
| Extract content from URLs    | `tavily_extract` | Have specific URLs, need their content                        |

## web_search

Tavily powers this automatically when selected as the search provider. Use for
straightforward queries where you don't need Tavily-specific options.

| Parameter | Description              |
| --------- | ------------------------ |
| `query`   | Search query string      |
| `count`   | Number of results (1-20) |

## tavily_search

Use when you need fine-grained control over search behavior.

| Parameter         | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `query`           | Search query string (keep under 400 characters)                       |
| `search_depth`    | `basic` (default, balanced) or `advanced` (highest relevance, slower) |
| `topic`           | `general` (default), `news` (real-time updates), or `finance`         |
| `max_results`     | Number of results, 1-20 (default: 5)                                  |
| `include_answer`  | Include an AI-generated answer summary (default: false)               |
| `time_range`      | Filter by recency: `day`, `week`, `month`, or `year`                  |
| `include_domains` | Array of domains to restrict results to                               |
| `exclude_domains` | Array of domains to exclude from results                              |

### Search depth

| Depth      | Speed  | Relevance | Best for                                     |
| ---------- | ------ | --------- | -------------------------------------------- |
| `basic`    | Faster | High      | General-purpose queries (default)            |
| `advanced` | Slower | Highest   | Precision, specific facts, detailed research |

### Tips

- **Keep queries under 400 characters** — think search query, not prompt.
- **Break complex queries into sub-queries** for better results.
- **Use `include_domains`** to focus on trusted sources.
- **Use `time_range`** for recent information (news, current events).
- **Use `include_answer`** when you need a quick synthesized answer.

## tavily_extract

Use when you have specific URLs and need their content. Handles JavaScript-rendered
pages and returns clean markdown. Supports query-focused chunking for targeted
extraction.

| Parameter           | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `urls`              | Array of URLs to extract (1-20 per request)                        |
| `query`             | Rerank extracted chunks by relevance to this query                 |
| `extract_depth`     | `basic` (default, fast) or `advanced` (for JS-heavy pages, tables) |
| `chunks_per_source` | Chunks per URL, 1-5 (requires `query`)                             |
| `include_images`    | Include image URLs in results (default: false)                     |

### Extract depth

| Depth      | When to use                                                 |
| ---------- | ----------------------------------------------------------- |
| `basic`    | Simple pages — try this first                               |
| `advanced` | JS-rendered SPAs, dynamic content, tables, embedded content |

### Tips

- **Max 20 URLs per request** — batch larger lists into multiple calls.
- **Use `query` + `chunks_per_source`** to get only relevant content instead of full pages.
- **Try `basic` first**, fall back to `advanced` if content is missing or incomplete.
- If `tavily_search` results already contain the snippets you need, skip the extract step.

## Choosing the right workflow

Follow this escalation pattern — start simple, escalate only when needed:

1. **`web_search`** — Quick lookup, no special options needed.
2. **`tavily_search`** — Need depth control, topic filtering, domain filters, time ranges, or AI answers.
3. **`tavily_extract`** — Have specific URLs, need their full content or targeted chunks.

Combine search + extract when you need to find pages first, then get their full content.
