# Crawl & Map API Reference

## Table of Contents

- [Crawl vs Map](#crawl-vs-map)
- [Key Parameters](#key-parameters)
- [Instructions and Chunks](#instructions-and-chunks)
- [Path and Domain Filtering](#path-and-domain-filtering)
- [Use Cases](#use-cases)
- [Map then Extract Pattern](#map-then-extract-pattern)
- [Performance Optimization](#performance-optimization)
- [Common Pitfalls](#common-pitfalls)
- [Response Fields](#response-fields)
- [Summary](#summary)

---

## Crawl vs Map

| Feature | Crawl | Map |
|---------|-------|-----|
| **Returns** | Full content | URLs only |
| **Speed** | Slower | Faster |
| **Best for** | RAG, deep analysis, documentation | Site structure discovery, URL collection |

**Use Crawl when:**
- Full content extraction needed
- Building RAG systems
- Processing paginated/nested content
- Integration with knowledge bases

**Use Map when:**
- Quick site structure discovery
- URL collection without content
- Planning before crawling
- Sitemap generation

---

## Key Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | Required | Root URL to begin |
| `max_depth` | integer | 1 | Levels deep to crawl (1-5). **Start with 1-2** |
| `max_breadth` | integer | 20 | Links per page. 50-100 for focused crawls |
| `limit` | integer | 50 | Total pages cap |
| `instructions` | string | null | Natural language guidance (2 credits/10 pages) |
| `chunks_per_source` | integer | 3 | Chunks per page (1-5). Only with `instructions` |
| `extract_depth` | enum | `"basic"` | `"basic"` (1 credit/5 URLs) or `"advanced"` (2 credits/5 URLs) |
| `format` | enum | `"markdown"` | `"markdown"` or `"text"` |
| `select_paths` | array | null | Regex patterns to include |
| `exclude_paths` | array | null | Regex patterns to exclude |
| `select_domains` | array | null | Regex for domains to include |
| `exclude_domains` | array | null | Regex for domains to exclude |
| `allow_external` | boolean | true (crawl) / false (map) | Include external domain links |
| `include_images` | boolean | false | Include images (crawl only) |
| `include_favicon` | boolean | false | Include favicon URL (crawl only) |
| `include_usage` | boolean | false | Include credit usage info |
| `timeout` | float | 150 | Max wait (10-150 seconds) |

---

## Instructions and Chunks

Use `instructions` and `chunks_per_source` for semantic focus and token optimization:

```python
response = client.crawl(
    url="https://docs.example.com",
    max_depth=2,
    instructions="Find all documentation about authentication and security",
    chunks_per_source=3  # Only top 3 relevant chunks per page
)
```

**Key benefits:**
- `instructions` guides crawler semantically, focusing on relevant content
- `chunks_per_source` returns only relevant snippets (max 500 chars each)
- Prevents context window explosion in agentic use cases
- Chunks appear in `raw_content` as: `<chunk 1> [...] <chunk 2> [...] <chunk 3>`

**Note:** `chunks_per_source` only works when `instructions` is provided.

---

## Path and Domain Filtering

### Path patterns (regex)

```python
# Target specific sections
response = client.crawl(
    url="https://example.com",
    select_paths=["/docs/.*", "/api/.*", "/guides/.*"],
    exclude_paths=["/blog/.*", "/changelog/.*", "/private/.*"]
)

# Paginated content
response = client.crawl(
    url="https://example.com/blog",
    max_depth=2,
    select_paths=["/blog/.*", "/blog/page/.*"],
    exclude_paths=["/blog/tag/.*"]
)
```

### Domain control (regex)

```python
# Stay within subdomain
response = client.crawl(
    url="https://docs.example.com",
    select_domains=["^docs.example.com$"],
    max_depth=2
)

# Exclude specific domains
response = client.crawl(
    url="https://example.com",
    exclude_domains=["^ads.example.com$", "^tracking.example.com$"]
)
```

---

## Use Cases

### 1. Deep/Unlinked Content
Deeply nested pages, paginated archives, internal search-only content.

```python
response = client.crawl(
    url="https://example.com",
    max_depth=3,
    max_breadth=50,
    limit=200,
    select_paths=["/blog/.*", "/changelog/.*"],
    exclude_paths=["/private/.*", "/admin/.*"]
)
```

### 2. Documentation/Structured Content
Documentation, changelogs, FAQs with nonstandard markup.

```python
response = client.crawl(
    url="https://docs.example.com",
    max_depth=2,
    extract_depth="advanced",
    select_paths=["/docs/.*"]
)
```

### 3. Multi-modal/Cross-referencing
Combining information from multiple sections.

```python
response = client.crawl(
    url="https://example.com",
    max_depth=2,
    instructions="Find all documentation pages that link to API reference docs",
    extract_depth="advanced"
)
```

### 4. Rapidly Changing Content
API docs, product announcements, news sections.

```python
response = client.crawl(
    url="https://api.example.com",
    max_depth=1,
    max_breadth=100
)
```

### 5. RAG/Knowledge Base Integration

```python
response = client.crawl(
    url="https://docs.example.com",
    max_depth=2,
    extract_depth="advanced",
    include_images=True,
    instructions="Extract all technical documentation and code examples"
)
```

### 6. Compliance/Auditing
Comprehensive content analysis for legal checks.

```python
response = client.crawl(
    url="https://example.com",
    max_depth=3,
    max_breadth=100,
    limit=1000,
    extract_depth="advanced",
    instructions="Find all mentions of GDPR and data protection policies"
)
```

### 7. Known URL Patterns
Sitemap-based crawling, section-specific extraction.

```python
response = client.crawl(
    url="https://example.com",
    max_depth=1,
    select_paths=["/docs/.*", "/api/.*", "/guides/.*"],
    exclude_paths=["/private/.*", "/admin/.*"]
)
```

---

## Map then Extract Pattern

Consider using Map before Crawl/Extract to plan your strategy:

1. **Use Map** to get site structure
2. **Analyze** paths and patterns
3. **Configure** Crawl or Extract with discovered paths
4. **Execute** focused extraction

```python
# Step 1: Map to discover structure
map_result = client.map(
    url="https://docs.example.com",
    max_depth=2,
    instructions="Find all API docs and guides"
)

# Step 2: Filter discovered URLs
api_docs = [url for url in map_result["results"] if "/api/" in url]
guides = [url for url in map_result["results"] if "/guides/" in url]
print(f"Found {len(api_docs)} API docs, {len(guides)} guides")

# Step 3: Extract from filtered URLs
target_urls = api_docs + guides
response = client.extract(
    urls=target_urls[:20],  # Max 20 per extract call
    extract_depth="advanced",
    query="API endpoints and usage examples",
    chunks_per_source=3
)
```

**Benefits:**
- Discover site structure before committing to full crawl
- Identify relevant path patterns
- Avoid unnecessary extraction
- More control over what gets extracted

---

## Performance Optimization

### Depth vs Performance

Each depth level increases crawl time exponentially:

| Depth | Typical Pages | Time |
|-------|---------------|------|
| 1 | 10-50 | Seconds |
| 2 | 50-500 | Minutes |
| 3 | 500-5000 | Many minutes |

**Best practices:**
- Start with `max_depth=1` and increase only if needed
- Use `max_breadth` to control horizontal expansion
- Set appropriate `limit` to prevent excessive crawling
- Process results incrementally rather than waiting for full crawl

### Rate Limiting

- Respect site's robots.txt
- Monitor API usage and limits
- Use appropriate error handling for rate limits
- Consider delays between large crawl operations

### Conservative vs Comprehensive

```python
# Conservative (start here)
response = client.crawl(
    url="https://example.com",
    max_depth=1,
    max_breadth=20,
    limit=20
)

# Comprehensive (use carefully)
response = client.crawl(
    url="https://example.com",
    max_depth=3,
    max_breadth=100,
    limit=500
)
```

---

## Common Pitfalls

| Problem | Impact | Solution |
|---------|--------|----------|
| Excessive depth (`max_depth=4+`) | Exponential time, unnecessary pages | Start with 1-2, increase if needed |
| Unfocused crawling | Wasted resources, irrelevant content, context explosion | Use `instructions` to focus semantically |
| Missing limits | Runaway crawls, unexpected costs | Always set reasonable `limit` value |
| Ignoring `failed_results` | Incomplete data, missed content | Monitor and adjust parameters |
| Full content without chunks | Context window explosion | Use `instructions` + `chunks_per_source` |

---

## Response Fields

### Crawl Response

| Field | Description |
|-------|-------------|
| `base_url` | The URL you started the crawl from |
| `results` | List of crawled pages |
| `results[].url` | Page URL |
| `results[].raw_content` | Extracted content (or chunks if instructions provided) |
| `results[].images` | Image URLs extracted from the page |
| `results[].favicon` | Favicon URL (if `include_favicon=True`) |
| `response_time` | Time in seconds |
| `request_id` | Unique identifier for support reference |

### Map Response

| Field | Description |
|-------|-------------|
| `base_url` | The URL you started the mapping from |
| `results` | List of discovered URLs |
| `response_time` | Time in seconds |
| `request_id` | Unique identifier for support reference |

---

## Summary

1. **Use instructions and chunks_per_source** for focused, relevant results in agentic use cases
2. **Start conservative** (`max_depth=1`, `max_breadth=20`) and scale up as needed
3. **Use path patterns** to focus crawling on relevant content
4. **Choose appropriate extract_depth** based on content complexity
5. **Always set a limit** to prevent runaway crawls and unexpected costs
6. **Monitor failed_results** and adjust patterns accordingly
7. **Use Map first** to understand site structure before committing to full crawl
8. **Implement error handling** for rate limits and failures
9. **Respect robots.txt** and site policies

> Crawling is powerful but resource-intensive. Focus your crawls, start small, monitor results, and scale gradually based on actual needs.

For more details, see the [full API reference](https://docs.tavily.com/documentation/api-reference/endpoint/crawl)
