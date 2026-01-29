# Extract API Reference

## Table of Contents

- [Extraction Approaches](#extraction-approaches)
- [Key Parameters](#key-parameters)
- [Query and Chunks](#query-and-chunks)
- [Extract Depth](#extract-depth)
- [Advanced Filtering Strategies](#advanced-filtering-strategies)
- [Response Fields](#response-fields)
- [Summary](#summary)

---

## Extraction Approaches

### Search with include_raw_content

Get search results and content in one call:

```python
response = client.search(
    query="AI healthcare applications",
    include_raw_content=True,
    max_results=5
)
```

**When to use:**
- Quick prototyping
- Simple queries where search results are likely relevant
- Single API call convenience

### Direct Extract API (Recommended)

Two-step pattern for more control:

```python
# Step 1: Search
search_results = client.search(
    query="Python async best practices",
    max_results=10
)

# Step 2: Filter by relevance score
relevant_urls = [
    r["url"] for r in search_results["results"]
    if r["score"] > 0.5
]

# Step 3: Extract with targeting
extracted = client.extract(
    urls=relevant_urls[:20],
    query="async patterns and concurrency",  # Reranks chunks
    chunks_per_source=3  # Prevents context explosion
)

for item in extracted["results"]:
    print(f"URL: {item['url']}")
    print(f"Content: {item['raw_content'][:500]}...")
```

**When to use:**
- You want control over which URLs to extract
- You need to filter/curate URLs before extraction
- You want targeted extraction with query and chunks_per_source

---

## Key Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `urls` | string/array | Required | Single URL or list (max 20) |
| `extract_depth` | enum | `"basic"` | `"basic"` or `"advanced"` (for complex/JS pages) |
| `query` | string | null | Reranks chunks by relevance to this query |
| `chunks_per_source` | integer | 3 | Chunks per source (1-5, max 500 chars each). Only with `query` |
| `format` | enum | `"markdown"` | Output: `"markdown"` or `"text"` |
| `include_images` | boolean | false | Include image URLs |
| `include_favicon` | boolean | false | Include favicon URL |
| `include_usage` | boolean | false | Include credit consumption data in response |
| `timeout` | float | varies | Max wait time (1.0-60.0 seconds) |

---

## Query and Chunks

Use `query` and `chunks_per_source` to get only relevant content and prevent context window explosion:

```python
extracted = client.extract(
    urls=[
        "https://example.com/ml-healthcare",
        "https://example.com/ai-diagnostics",
        "https://example.com/medical-ai"
    ],
    query="AI diagnostic tools accuracy",
    chunks_per_source=2  # 2 most relevant chunks per URL
)
```

**When to use query:**
- To extract only relevant portions of long documents
- When you need focused content instead of full page extraction
- For targeted information retrieval from specific URLs

**Key benefits of chunks_per_source:**
- Returns only relevant snippets (max 500 chars each) instead of full page
- Chunks appear in `raw_content` as: `<chunk 1> [...] <chunk 2> [...] <chunk 3>`
- Prevents context window from exploding in agentic use cases

**Note:** `chunks_per_source` only works when `query` is provided.

---

## Extract Depth

| Depth | When to use |
|-------|-------------|
| `basic` (default) | Simple text extraction, faster |
| `advanced` | Dynamic/JS-rendered pages, tables, structured data, embedded media |

```python
# For complex pages
extracted = client.extract(
    urls=["https://example.com/complex-page"],
    extract_depth="advanced"
)
```

**Fallback strategy:** If `basic` fails, retry with `advanced`:

```python
result = client.extract(urls=[url], extract_depth="basic")
if url in [f["url"] for f in result.get("failed_results", [])]:
    result = client.extract(urls=[url], extract_depth="advanced")
```

**Timeout tuning:** If latency isn't critical, set `timeout=60.0` for better success on slow pages.

---

## Advanced Filtering Strategies

Beyond query-based filtering, consider these approaches before extraction:

| Strategy | When to use |
|----------|-------------|
| Score-based | Filter search results by relevance score |
| Domain-based | Filter by trusted domains |
| Re-ranking | Use dedicated re-ranking models for precision |
| LLM-based | Let an LLM assess relevance before extraction |
| Clustering | Group similar documents, extract from clusters |

### Optimal Workflow

1. **Search** to discover relevant URLs
2. **Filter** by relevance score, domain, or content snippet
3. **Re-rank** if needed using specialized models
4. **Extract** from top-ranked sources with query and chunks_per_source
5. **Validate** extracted content quality
6. **Process** for your AI application

### Example: Complete Pipeline

```python
import asyncio
from tavily import AsyncTavilyClient

client = AsyncTavilyClient()

async def content_pipeline(topic):
    # 1. Search with sub-queries for breadth
    queries = [
        f"{topic} overview",
        f"{topic} best practices",
        f"{topic} recent developments"
    ]
    responses = await asyncio.gather(
        *(client.search(q, search_depth="advanced", max_results=10) for q in queries)
    )

    # 2. Filter and aggregate by score
    urls = []
    for response in responses:
        urls.extend([
            r['url'] for r in response['results']
            if r['score'] > 0.5
        ])

    # 3. Deduplicate
    urls = list(set(urls))[:20]

    # 4. Extract with error handling
    extracted = await asyncio.gather(
        *(client.extract(urls=[url], query=topic, extract_depth="advanced")
          for url in urls),
        return_exceptions=True
    )

    # 5. Filter successful extractions
    return [e for e in extracted if not isinstance(e, Exception)]

asyncio.run(content_pipeline("machine learning in healthcare"))
```

---

## Response Fields

**Top-level response:**

| Field | Description |
|-------|-------------|
| `results` | Array of successfully extracted content |
| `failed_results` | Array of URLs that failed extraction |
| `response_time` | Time in seconds |
| `request_id` | Unique identifier for support reference |
| `usage` | Credit usage info (if `include_usage=True`) |

**Each result object:**

| Field | Description |
|-------|-------------|
| `url` | The URL extracted from |
| `raw_content` | Full content, or top-ranked chunks joined by `[...]` when `query` provided |
| `images` | Array of image URLs (if `include_images=true`) |
| `favicon` | Favicon URL (if `include_favicon=true`) |

**Each failed_results object:**

| Field | Description |
|-------|-------------|
| `url` | The URL that failed |
| `error` | Error message |

---

## Summary

1. **Use query and chunks_per_source** for targeted, focused extraction
2. **Choose Extract API** when you need control over which URLs to extract from
3. **Filter URLs** before extraction using scores, re-ranking, or domain trust
4. **Choose appropriate extract_depth** based on content complexity
5. **Process URLs concurrently** with async operations for better performance
6. **Implement error handling** to manage failed extractions gracefully
7. **Validate extracted content** before downstream processing

For more details, see the [full API reference](https://docs.tavily.com/documentation/api-reference/endpoint/extract)
