#!/bin/bash
# Tavily Crawl API script
# Usage: ./crawl.sh '{"url": "https://example.com", ...}' [output_dir]
# Example: ./crawl.sh '{"url": "https://docs.example.com", "max_depth": 2, "limit": 20}' ./crawled

set -e

JSON_INPUT="$1"
OUTPUT_DIR="$2"

if [ -z "$JSON_INPUT" ]; then
    echo "Usage: ./crawl.sh '<json>' [output_dir]"
    echo ""
    echo "Required:"
    echo "  url: string - Root URL to begin crawling"
    echo ""
    echo "Optional:"
    echo "  max_depth: 1-5 (default: 1) - Levels deep to crawl"
    echo "  max_breadth: integer (default: 20) - Links per page"
    echo "  limit: integer (default: 50) - Total pages cap"
    echo "  instructions: string - Natural language guidance for semantic focus"
    echo "  chunks_per_source: 1-5 (default: 3, only with instructions)"
    echo "  extract_depth: \"basic\" (default), \"advanced\""
    echo "  format: \"markdown\" (default), \"text\""
    echo "  select_paths: [\"regex1\", \"regex2\"] - Paths to include"
    echo "  exclude_paths: [\"regex1\", \"regex2\"] - Paths to exclude"
    echo "  select_domains: [\"regex1\"] - Domains to include"
    echo "  exclude_domains: [\"regex1\"] - Domains to exclude"
    echo "  allow_external: true/false (default: true)"
    echo "  include_images: true/false"
    echo "  include_favicon: true/false"
    echo "  timeout: 10-150 seconds (default: 150)"
    echo ""
    echo "Arguments:"
    echo "  output_dir: optional directory to save markdown files"
    echo ""
    echo "Example:"
    echo "  ./crawl.sh '{\"url\": \"https://docs.example.com\", \"max_depth\": 2, \"select_paths\": [\"/api/.*\"]}' ./output"
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

# Check for required url field
if ! echo "$JSON_INPUT" | jq -e '.url' >/dev/null 2>&1; then
    echo "Error: 'url' field is required"
    exit 1
fi

# Ensure format is set to markdown for file output
if [ -n "$OUTPUT_DIR" ]; then
    JSON_INPUT=$(echo "$JSON_INPUT" | jq '. + {format: "markdown"}')
fi

URL=$(echo "$JSON_INPUT" | jq -r '.url')
echo "Crawling: $URL"

RESPONSE=$(curl -s --request POST \
    --url https://api.tavily.com/crawl \
    --header "Authorization: Bearer $TAVILY_API_KEY" \
    --header 'Content-Type: application/json' \
    --header 'x-client-source: claude-code-skill' \
    --data "$JSON_INPUT")

if [ -n "$OUTPUT_DIR" ]; then
    mkdir -p "$OUTPUT_DIR"

    # Save each result as a markdown file
    echo "$RESPONSE" | jq -r '.results[] | @base64' | while read -r item; do
        _jq() {
            echo "$item" | base64 --decode | jq -r "$1"
        }

        PAGE_URL=$(_jq '.url')
        CONTENT=$(_jq '.raw_content')

        # Create filename from URL
        FILENAME=$(echo "$PAGE_URL" | sed 's|https\?://||' | sed 's|[/:?&=]|_|g' | cut -c1-100)
        FILEPATH="$OUTPUT_DIR/${FILENAME}.md"

        echo "# $PAGE_URL" > "$FILEPATH"
        echo "" >> "$FILEPATH"
        echo "$CONTENT" >> "$FILEPATH"

        echo "Saved: $FILEPATH"
    done

    echo "Crawl complete. Files saved to: $OUTPUT_DIR"
else
    echo "$RESPONSE" | jq '.'
fi
