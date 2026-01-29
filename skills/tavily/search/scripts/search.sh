#!/bin/bash
# Tavily Search API script
# Usage: ./search.sh '{"query": "your search query", ...}'
# Example: ./search.sh '{"query": "AI news", "topic": "news", "time_range": "week", "max_results": 10}'

set -e

JSON_INPUT="$1"

if [ -z "$JSON_INPUT" ]; then
    echo "Usage: ./search.sh '<json>'"
    echo ""
    echo "Required:"
    echo "  query: string - Search query (keep under 400 chars)"
    echo ""
    echo "Optional:"
    echo "  search_depth: \"ultra-fast\", \"fast\", \"basic\" (default), \"advanced\""
    echo "  topic: \"general\" (default), \"news\", \"finance\""
    echo "  max_results: 1-20 (default: 5)"
    echo "  chunks_per_source: 1-5 (default: 3, advanced/fast depth only)"
    echo "  time_range: \"day\", \"week\", \"month\", \"year\""
    echo "  start_date: \"YYYY-MM-DD\""
    echo "  end_date: \"YYYY-MM-DD\""
    echo "  include_domains: [\"domain1.com\", \"domain2.com\"]"
    echo "  exclude_domains: [\"domain1.com\", \"domain2.com\"]"
    echo "  country: country name (general topic only)"
    echo "  include_answer: true/false or \"basic\"/\"advanced\""
    echo "  include_raw_content: true/false or \"markdown\"/\"text\""
    echo "  include_images: true/false"
    echo "  include_image_descriptions: true/false"
    echo "  include_favicon: true/false"
    echo ""
    echo "Example:"
    echo "  ./search.sh '{\"query\": \"latest AI trends\", \"topic\": \"news\", \"time_range\": \"week\"}'"
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

# Check for required query field
if ! echo "$JSON_INPUT" | jq -e '.query' >/dev/null 2>&1; then
    echo "Error: 'query' field is required"
    exit 1
fi

curl -s --request POST \
    --url https://api.tavily.com/search \
    --header "Authorization: Bearer $TAVILY_API_KEY" \
    --header 'Content-Type: application/json' \
    --header 'x-client-source: claude-code-skill' \
    --data "$JSON_INPUT" | jq '.'
