---
name: firecrawl-cli
description: |
  Firecrawl CLI for web scraping, crawling, and search. Scrape single pages or entire websites, map site URLs, and search the web with full content extraction. Returns clean markdown optimized for LLM context. Use for research, documentation extraction, competitive intelligence, and content monitoring.
---

# Firecrawl CLI

Use the `firecrawl` CLI to fetch and search the web. Firecrawl returns clean markdown optimized for LLM context windows, handles JavaScript rendering, bypasses common blocks, and provides structured data.

## Installation

Check status, auth, and rate limits:

```bash
firecrawl --status
```

Output when ready:

```
  🔥 firecrawl cli v1.0.2

  ● Authenticated via FIRECRAWL_API_KEY
  Concurrency: 0/100 jobs (parallel scrape limit)
  Credits: 500,000 remaining
```

- **Concurrency**: Max parallel jobs. Run parallel operations close to this limit but not above.
- **Credits**: Remaining API credits. Each scrape/crawl consumes credits.

If not installed: `npm install -g firecrawl-cli`

Always refer to the installation rules in [rules/install.md](rules/install.md) for more information if the user is not logged in.

## Authentication

If not authenticated, run:

```bash
firecrawl login --browser
```

The `--browser` flag automatically opens the browser for authentication without prompting.

## Organization

Create a `.firecrawl/` folder in the working directory unless it already exists to store results. Add `.firecrawl/` to the `.gitignore` file if not already there. Always use `-o` to write directly to file (avoids flooding context):

```bash
# Search the web (most common operation)
firecrawl search "your query" -o .firecrawl/search-{query}.json

# Search with scraping enabled
firecrawl search "your query" --scrape -o .firecrawl/search-{query}-scraped.json

# Scrape a page
firecrawl scrape https://example.com -o .firecrawl/{site}-{path}.md
```

Examples:

```
.firecrawl/search-react_server_components.json
.firecrawl/search-ai_news-scraped.json
.firecrawl/docs.github.com-actions-overview.md
.firecrawl/firecrawl.dev.md
```

## Commands

### Search - Web search with optional scraping

```bash
# Basic search (human-readable output)
firecrawl search "your query" -o .firecrawl/search-query.txt

# JSON output (recommended for parsing)
firecrawl search "your query" -o .firecrawl/search-query.json --json

# Limit results
firecrawl search "AI news" --limit 10 -o .firecrawl/search-ai-news.json --json

# Search specific sources
firecrawl search "tech startups" --sources news -o .firecrawl/search-news.json --json
firecrawl search "landscapes" --sources images -o .firecrawl/search-images.json --json
firecrawl search "machine learning" --sources web,news,images -o .firecrawl/search-ml.json --json

# Filter by category (GitHub repos, research papers, PDFs)
firecrawl search "web scraping python" --categories github -o .firecrawl/search-github.json --json
firecrawl search "transformer architecture" --categories research -o .firecrawl/search-research.json --json

# Time-based search
firecrawl search "AI announcements" --tbs qdr:d -o .firecrawl/search-today.json --json  # Past day
firecrawl search "tech news" --tbs qdr:w -o .firecrawl/search-week.json --json          # Past week

# Location-based search
firecrawl search "restaurants" --location "San Francisco,California,United States" -o .firecrawl/search-sf.json --json
firecrawl search "local news" --country DE -o .firecrawl/search-germany.json --json

# Search AND scrape content from results
firecrawl search "firecrawl tutorials" --scrape -o .firecrawl/search-scraped.json --json
firecrawl search "API docs" --scrape --scrape-formats markdown,links -o .firecrawl/search-docs.json --json
```

**Search Options:**

| Option | Description |
|--------|-------------|
| `--limit <n>` | Maximum results (default: 5, max: 100) |
| `--sources <sources>` | Comma-separated: web, images, news (default: web) |
| `--categories <categories>` | Comma-separated: github, research, pdf |
| `--tbs <value>` | Time filter: qdr:h (hour), qdr:d (day), qdr:w (week), qdr:m (month), qdr:y (year) |
| `--location <location>` | Geo-targeting (e.g., "Germany") |
| `--country <code>` | ISO country code (default: US) |
| `--scrape` | Enable scraping of search results |
| `--scrape-formats <formats>` | Scrape formats when --scrape enabled (default: markdown) |
| `-o, --output <path>` | Save to file |

### Scrape - Single page content extraction

```bash
# Basic scrape (markdown output)
firecrawl scrape https://example.com -o .firecrawl/example.md

# Get raw HTML
firecrawl scrape https://example.com --html -o .firecrawl/example.html

# Multiple formats (JSON output)
firecrawl scrape https://example.com --format markdown,links -o .firecrawl/example.json

# Main content only (removes nav, footer, ads)
firecrawl scrape https://example.com --only-main-content -o .firecrawl/example.md

# Wait for JS to render
firecrawl scrape https://spa-app.com --wait-for 3000 -o .firecrawl/spa.md

# Extract links only
firecrawl scrape https://example.com --format links -o .firecrawl/links.json

# Include/exclude specific HTML tags
firecrawl scrape https://example.com --include-tags article,main -o .firecrawl/article.md
firecrawl scrape https://example.com --exclude-tags nav,aside,.ad -o .firecrawl/clean.md
```

**Scrape Options:**

| Option | Description |
|--------|-------------|
| `-f, --format <formats>` | Output format(s): markdown, html, rawHtml, links, screenshot, json |
| `-H, --html` | Shortcut for `--format html` |
| `--only-main-content` | Extract main content only |
| `--wait-for <ms>` | Wait before scraping (for JS content) |
| `--include-tags <tags>` | Only include specific HTML tags |
| `--exclude-tags <tags>` | Exclude specific HTML tags |
| `-o, --output <path>` | Save to file |

### Crawl - Crawl an entire website

```bash
# Start a crawl (returns job ID)
firecrawl crawl https://example.com

# Wait for crawl to complete
firecrawl crawl https://example.com --wait

# With progress indicator
firecrawl crawl https://example.com --wait --progress

# Check crawl status
firecrawl crawl <job-id>

# Limit pages
firecrawl crawl https://example.com --limit 100 --max-depth 3

# Crawl blog section only
firecrawl crawl https://example.com --include-paths /blog,/posts

# Exclude admin pages
firecrawl crawl https://example.com --exclude-paths /admin,/login

# Crawl with rate limiting
firecrawl crawl https://example.com --delay 1000 --max-concurrency 2

# Save results
firecrawl crawl https://example.com --wait -o crawl-results.json --pretty
```

**Crawl Options:**

| Option | Description |
|--------|-------------|
| `--wait` | Wait for crawl to complete |
| `--progress` | Show progress while waiting |
| `--limit <n>` | Maximum pages to crawl |
| `--max-depth <n>` | Maximum crawl depth |
| `--include-paths <paths>` | Only crawl matching paths |
| `--exclude-paths <paths>` | Skip matching paths |
| `--delay <ms>` | Delay between requests |
| `--max-concurrency <n>` | Max concurrent requests |

### Map - Discover all URLs on a site

```bash
# List all URLs (one per line)
firecrawl map https://example.com -o .firecrawl/urls.txt

# Output as JSON
firecrawl map https://example.com --json -o .firecrawl/urls.json

# Search for specific URLs
firecrawl map https://example.com --search "blog" -o .firecrawl/blog-urls.txt

# Limit results
firecrawl map https://example.com --limit 500 -o .firecrawl/urls.txt

# Include subdomains
firecrawl map https://example.com --include-subdomains -o .firecrawl/all-urls.txt
```

**Map Options:**

| Option | Description |
|--------|-------------|
| `--limit <n>` | Maximum URLs to discover |
| `--search <query>` | Filter URLs by search query |
| `--sitemap <mode>` | include, skip, or only |
| `--include-subdomains` | Include subdomains |
| `--json` | Output as JSON |
| `-o, --output <path>` | Save to file |

### Credit Usage

```bash
# Show credit usage
firecrawl credit-usage

# Output as JSON
firecrawl credit-usage --json --pretty
```

## Reading Scraped Files

NEVER read entire firecrawl output files at once unless explicitly asked - they can be 1000+ lines. Instead, use grep, head, or incremental reads:

```bash
# Check file size and preview structure
wc -l .firecrawl/file.md && head -50 .firecrawl/file.md

# Use grep to find specific content
grep -n "keyword" .firecrawl/file.md
grep -A 10 "## Section" .firecrawl/file.md
```

## Parallelization

Run multiple scrapes in parallel using `&` and `wait`:

```bash
# Parallel scraping (fast)
firecrawl scrape https://site1.com -o .firecrawl/1.md &
firecrawl scrape https://site2.com -o .firecrawl/2.md &
firecrawl scrape https://site3.com -o .firecrawl/3.md &
wait
```

For many URLs, use xargs with `-P` for parallel execution:

```bash
cat urls.txt | xargs -P 10 -I {} sh -c 'firecrawl scrape "{}" -o ".firecrawl/$(echo {} | md5).md"'
```

## Combining with Other Tools

```bash
# Extract URLs from search results
jq -r '.data.web[].url' .firecrawl/search-query.json

# Get titles from search results
jq -r '.data.web[] | "\(.title): \(.url)"' .firecrawl/search-query.json

# Count URLs from map
firecrawl map https://example.com | wc -l
```
