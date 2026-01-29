# SDK Reference

## Table of Contents

- [Python SDK](#python-sdk)
- [JavaScript SDK](#javascript-sdk)
- [Async Patterns](#async-patterns)
- [Hybrid RAG](#hybrid-rag)

---

## Python SDK

### Installation

```bash
pip install tavily-python
```

### Client Initialization

```python
from tavily import TavilyClient

# Uses TAVILY_API_KEY env var (recommended)
client = TavilyClient()

# Explicit API key
client = TavilyClient(api_key="tvly-YOUR_API_KEY")

# With project tracking
client = TavilyClient(api_key="tvly-YOUR_API_KEY", project_id="your-project-id")

# With proxies
proxies = {"http": "<proxy>", "https": "<proxy>"}
client = TavilyClient(api_key="tvly-YOUR_API_KEY", proxies=proxies)
```

### Async Client

```python
from tavily import AsyncTavilyClient

async_client = AsyncTavilyClient()

# Parallel queries
import asyncio
responses = await asyncio.gather(
    async_client.search("query 1"),
    async_client.search("query 2"),
    async_client.search("query 3")
)
```

### Methods

#### search()

```python
response = client.search(
    query="quantum computing breakthroughs",
    search_depth="advanced",      # "basic" | "advanced"
    topic="general",              # "general" | "news" | "finance"
    max_results=10,               # 0-20
    include_answer=False,         # bool | "basic" | "advanced"
    include_raw_content=False,    # bool | "markdown" | "text"
    include_images=False,
    time_range="week",            # "day" | "week" | "month" | "year"
    include_domains=["arxiv.org"],
    exclude_domains=["reddit.com"],
    country="united states"
)
```

#### extract()

```python
response = client.extract(
    urls=["https://example.com/page1", "https://example.com/page2"],
    extract_depth="basic",        # "basic" | "advanced"
    format="markdown",            # "markdown" | "text"
    include_images=False,
    query="focus query",          # Reranks chunks by relevance
    chunks_per_source=3           # 1-5, requires query
)
```

#### crawl()

```python
response = client.crawl(
    url="https://docs.example.com",
    max_depth=2,                  # 1-5
    max_breadth=20,
    limit=50,
    instructions="Find API documentation",
    chunks_per_source=3,          # 1-5, requires instructions
    select_paths=["/docs/.*"],
    exclude_paths=["/blog/.*"],
    extract_depth="basic",
    format="markdown",
    allow_external=True
)
```

#### map()

```python
response = client.map(
    url="https://docs.example.com",
    max_depth=2,
    max_breadth=20,
    limit=50,
    instructions="Find all API pages",
    select_paths=["/api/.*"],
    allow_external=False
)
```

#### research()

```python
# Start research task
result = client.research(
    input="Analyze competitive landscape for X",
    model="pro",                  # "mini" | "pro" | "auto"
    stream=False,
    output_schema=None,           # JSON schema for structured output
    citation_format="numbered"    # "numbered" | "mla" | "apa" | "chicago"
)

# Poll for results
import time
response = client.get_research(result["request_id"])
while response["status"] not in ["completed", "failed"]:
    time.sleep(10)
    response = client.get_research(result["request_id"])
```

---

## JavaScript SDK

### Installation

```bash
npm install @tavily/core
```

### Client Initialization

```javascript
const { tavily } = require("@tavily/core");

// Basic initialization
const client = tavily({ apiKey: "tvly-YOUR_API_KEY" });

// With project tracking
const client = tavily({
  apiKey: "tvly-YOUR_API_KEY",
  projectId: "your-project-id"
});

// With proxies
const client = tavily({
  apiKey: "tvly-YOUR_API_KEY",
  proxies: {
    http: "<proxy>",
    https: "<proxy>"
  }
});
```

### Methods

#### search()

```javascript
const response = await client.search("quantum computing", {
  searchDepth: "advanced",      // "basic" | "advanced"
  topic: "general",             // "general" | "news" | "finance"
  maxResults: 10,               // 0-20
  includeAnswer: false,         // boolean | "basic" | "advanced"
  includeRawContent: false,     // boolean | "markdown" | "text"
  includeImages: false,
  timeRange: "week",            // "day" | "week" | "month" | "year"
  includeDomains: ["arxiv.org"],
  excludeDomains: ["reddit.com"],
  country: "united states"
});
```

#### extract()

```javascript
const response = await client.extract([
  "https://example.com/page1",
  "https://example.com/page2"
], {
  extractDepth: "basic",        // "basic" | "advanced"
  format: "markdown",           // "markdown" | "text"
  includeImages: false,
  query: "focus query"          // Reranks chunks
});
```

#### crawl()

```javascript
const response = await client.crawl("https://docs.example.com", {
  maxDepth: 2,
  maxBreadth: 20,
  limit: 50,
  instructions: "Find API documentation",
  selectPaths: ["/docs/.*"],
  excludePaths: ["/blog/.*"],
  extractDepth: "basic",
  format: "markdown"
});
```

#### map()

```javascript
const response = await client.map("https://docs.example.com", {
  maxDepth: 2,
  maxBreadth: 20,
  limit: 50,
  instructions: "Find all API pages"
});
```

---

## Async Patterns

### Python Parallel Queries

```python
import asyncio
from tavily import AsyncTavilyClient

client = AsyncTavilyClient()

async def parallel_search():
    queries = [
        "AI trends 2025",
        "machine learning best practices",
        "LLM deployment strategies"
    ]

    responses = await asyncio.gather(
        *(client.search(q, search_depth="advanced") for q in queries),
        return_exceptions=True
    )

    for query, response in zip(queries, responses):
        if isinstance(response, Exception):
            print(f"Failed: {query}")
        else:
            print(f"{query}: {len(response['results'])} results")

asyncio.run(parallel_search())
```

### JavaScript Parallel Queries

```javascript
const queries = ["AI trends", "ML practices", "LLM strategies"];

const responses = await Promise.all(
  queries.map(q => client.search(q, { searchDepth: "advanced" }))
);

responses.forEach((response, i) => {
  console.log(`${queries[i]}: ${response.results.length} results`);
});
```

---

## Hybrid RAG

Combine web search with local database retrieval.

### Python

```python
from tavily import TavilyHybridClient
from pymongo import MongoClient

# Connect to MongoDB
db = MongoClient("mongodb+srv://URI")["DB_NAME"]

# Initialize hybrid client
hybrid_client = TavilyHybridClient(
    api_key="tvly-YOUR_API_KEY",
    db_provider="mongodb",
    collection=db.get_collection("documents"),
    embeddings_field="embeddings",
    content_field="content"
)

# Search across web + local DB
results = hybrid_client.search(
    query="quantum computing advances",
    max_results=10,
    max_local=5,      # Results from local DB
    max_foreign=5,    # Results from web
    save_foreign=True # Store web results in DB
)
```

**Environment Variables:**
- `TAVILY_PROJECT`: Default project ID
- `TAVILY_HTTP_PROXY` / `TAVILY_HTTPS_PROXY`: Proxy configuration
- `CO_API_KEY`: Cohere API key for embeddings

---

## Response Structures

### Search Response

```python
{
    "query": str,
    "results": [
        {
            "title": str,
            "url": str,
            "content": str,
            "score": float,
            "favicon": str
        }
    ],
    "response_time": float,
    "request_id": str,
    "answer": str,      # if include_answer
    "images": list      # if include_images
}
```

### Extract Response

```python
{
    "results": [
        {
            "url": str,
            "raw_content": str,
            "images": list,
            "favicon": str
        }
    ],
    "failed_results": [
        {"url": str, "error": str}
    ],
    "response_time": float,
    "request_id": str
}
```

### Crawl Response

```python
{
    "base_url": str,
    "results": [
        {
            "url": str,
            "raw_content": str,
            "images": list,
            "favicon": str
        }
    ],
    "response_time": float,
    "request_id": str
}
```

### Map Response

```python
{
    "base_url": str,
    "results": [str],  # List of URLs
    "response_time": float,
    "request_id": str
}
```

---

For full API documentation, see:
- [Python SDK Reference](https://docs.tavily.com/sdk/python/reference)
- [JavaScript SDK Reference](https://docs.tavily.com/sdk/javascript/reference)
