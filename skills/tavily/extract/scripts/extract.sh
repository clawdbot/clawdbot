#!/bin/bash
# Tavily Extract API script
# Usage: ./extract.sh '{"urls": ["url1", "url2"], ...}'
# Example: ./extract.sh '{"urls": ["https://example.com"], "query": "API usage", "chunks_per_source": 3}'

set -e

JSON_INPUT="$1"

if [ -z "$JSON_INPUT" ]; then
    echo "Usage: ./extract.sh '<json>'"
    echo ""
    echo "Required:"
    echo "  urls: string or array - Single URL or list (max 20)"
    echo ""
    echo "Optional:"
    echo "  extract_depth: \"basic\" (default), \"advanced\" (for JS/complex pages)"
    echo "  query: string - Reranks chunks by relevance to this query"
    echo "  chunks_per_source: 1-5 (default: 3, only with query)"
    echo "  format: \"markdown\" (default), \"text\""
    echo "  include_images: true/false"
    echo "  include_favicon: true/false"
    echo "  timeout: 1.0-60.0 seconds"
    echo ""
    echo "Example:"
    echo "  ./extract.sh '{\"urls\": [\"https://docs.example.com/api\"], \"query\": \"authentication\", \"chunks_per_source\": 3}'"
    exit 1
fi

if [ -z "$TAVILY_API_KEY" ]; then
    echo "Error: TAVILY_API_KEY environment variable not set"
    exit 1
fi

# Validate JSON
if ! echo "$JSON_INPUT" | jq empty 2>/dev/null; then
    echo "Error: Invalid JSON input"
    exit 1
fi

# Check for required urls field
if ! echo "$JSON_INPUT" | jq -e '.urls' >/dev/null 2>&1; then
    echo "Error: 'urls' field is required"
    exit 1
fi

curl -s --request POST \
    --url https://api.tavily.com/extract \
    --header "Authorization: Bearer $TAVILY_API_KEY" \
    --header 'Content-Type: application/json' \
    --header 'x-client-source: claude-code-skill' \
    --data "$JSON_INPUT" | jq '.'
