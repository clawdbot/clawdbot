---
name: tavily-best-practices
description: "Build production-ready Tavily integrations with best practices baked in. Reference documentation for developers using coding assistants (Claude Code, Cursor, etc.) to implement web search, content extraction, crawling, and research in agentic workflows, RAG systems, or autonomous agents."
---

# Tavily

Tavily is a search API designed for LLMs, enabling AI applications to access real-time web data.

## Prerequisites

**Tavily API Key Required** - Get your key at https://app.tavily.com (1,000 free API credits/month, no credit card required)

Add to `~/.claude/settings.json`:
```json
{
  "env": {
    "TAVILY_API_KEY": "tvly-YOUR_API_KEY"
  }
}
```

Restart Claude Code after adding your API key.

## Installation

**Python:**
```bash
pip install tavily-python
```

**JavaScript:**
```bash
npm install @tavily/core
```

See **[references/sdk.md](references/sdk.md)** for complete SDK reference.

## Client Initialization

```python
from tavily import TavilyClient

# Option 1: Uses TAVILY_API_KEY env var (recommended)
client = TavilyClient()

# Option 2: Explicit API key
client = TavilyClient(api_key="tvly-YOUR_API_KEY")

# Option 3: With project tracking (for usage organization)
client = TavilyClient(api_key="tvly-YOUR_API_KEY", project_id="your-project-id")

# Async client for parallel queries
from tavily import AsyncTavilyClient
async_client = AsyncTavilyClient()
```

## Choosing the Right Method

**For custom agents/workflows:**

| Need | Method |
|------|--------|
| Web search results | `search()` |
| Content from specific URLs | `extract()` |
| Content from entire site | `crawl()` |
| URL discovery from site | `map()` |

**For out-of-the-box research:**

| Need | Method |
|------|--------|
| End-to-end research with AI synthesis | `research()` |

## Quick Reference

### search() - Web Search

```python
response = client.search(
    query="quantum computing breakthroughs",  # Keep under 400 chars
    max_results=10,
    search_depth="advanced",  # 2 credits, highest relevance
    topic="general"  # or "news", "finance"
)

for result in response["results"]:
    print(f"{result['title']}: {result['score']}")
```

Key parameters: `query`, `max_results`, `search_depth` (ultra-fast/fast/basic/advanced), `topic`, `include_domains`, `exclude_domains`, `time_range`

### extract() - URL Content Extraction

```python
# Two-step pattern (recommended for control)
search_results = client.search(query="Python async best practices")
urls = [r["url"] for r in search_results["results"] if r["score"] > 0.5]
extracted = client.extract(
    urls=urls[:20],
    query="async patterns",  # Reranks chunks by relevance
    chunks_per_source=3  # Prevents context explosion
)
```

Key parameters: `urls` (max 20), `extract_depth`, `query`, `chunks_per_source` (1-5)

### crawl() - Site-Wide Extraction

```python
response = client.crawl(
    url="https://docs.example.com",
    max_depth=2,
    instructions="Find API documentation pages",  # Semantic focus
    chunks_per_source=3,  # Token optimization
    select_paths=["/docs/.*", "/api/.*"]
)
```

Key parameters: `url`, `max_depth`, `max_breadth`, `limit`, `instructions`, `chunks_per_source`, `select_paths`, `exclude_paths`

### map() - URL Discovery

```python
response = client.map(
    url="https://docs.example.com",
    max_depth=2,
    instructions="Find all API and guide pages"
)
api_docs = [url for url in response["results"] if "/api/" in url]
```

### research() - AI-Powered Research

```python
import time

# For comprehensive multi-topic research
result = client.research(
    input="Analyze competitive landscape for X in SMB market",
    model="pro"  # or "mini" for focused queries, "auto" when unsure
)
request_id = result["request_id"]

# Poll until completed
response = client.get_research(request_id)
while response["status"] not in ["completed", "failed"]:
    time.sleep(10)
    response = client.get_research(request_id)

print(response["content"])  # The research report
```

Key parameters: `input`, `model` ("mini"/"pro"/"auto"), `stream`, `output_schema`, `citation_format`

## Detailed Guides

For complete parameters, response fields, patterns, and examples:

- **[references/sdk.md](references/sdk.md)** - Python & JavaScript SDK reference, async patterns, Hybrid RAG
- **[references/search.md](references/search.md)** - Query optimization, search depth selection, domain filtering, async patterns, post-filtering
- **[references/extract.md](references/extract.md)** - One-step vs two-step extraction, query/chunks for targeting, advanced mode
- **[references/crawl.md](references/crawl.md)** - Crawl vs Map, instructions for semantic focus, use cases, Map-then-Extract pattern
- **[references/research.md](references/research.md)** - Prompting best practices, model selection, streaming, structured output schemas
- **[references/integrations.md](references/integrations.md)** - LangChain, LlamaIndex, CrewAI, Vercel AI SDK, and framework integrations
