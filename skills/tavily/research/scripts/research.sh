#!/bin/bash
# Tavily Research API script
# Usage: ./research.sh '{"input": "your research query", ...}' [output_file]
# Example: ./research.sh '{"input": "quantum computing trends", "model": "pro"}' results.md

set -e

JSON_INPUT="$1"
OUTPUT_FILE="$2"

if [ -z "$JSON_INPUT" ]; then
    echo "Usage: ./research.sh '<json>' [output_file]"
    echo ""
    echo "Required:"
    echo "  input: string - The research topic or question"
    echo ""
    echo "Optional:"
    echo "  model: \"mini\", \"pro\", \"auto\" (default)"
    echo "    - mini: Targeted, efficient research for narrow questions"
    echo "    - pro: Comprehensive, multi-agent research for complex topics"
    echo "    - auto: Automatically selects based on query complexity"
    echo "  (streaming disabled for token management)"
    echo "  citation_format: \"numbered\" (default), \"mla\", \"apa\", \"chicago\""
    echo "  output_schema: JSON Schema object for structured output"
    echo ""
    echo "Arguments:"
    echo "  output_file: optional file to save results"
    echo ""
    echo "Example:"
    echo "  ./research.sh '{\"input\": \"AI agent frameworks comparison\", \"model\": \"pro\"}' report.md"
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

# Check for required input field
if ! echo "$JSON_INPUT" | jq -e '.input' >/dev/null 2>&1; then
    echo "Error: 'input' field is required"
    exit 1
fi

# Add citation format default if not specified, disable streaming for token management
JSON_INPUT=$(echo "$JSON_INPUT" | jq '
    . + {stream: false} |
    if .citation_format == null then . + {citation_format: "numbered"} else . end
')

INPUT=$(echo "$JSON_INPUT" | jq -r '.input')
MODEL=$(echo "$JSON_INPUT" | jq -r '.model // "auto"')

echo "Researching: $INPUT (model: $MODEL)"
echo "This may take 30-120 seconds..."

RESPONSE=$(curl -sN --request POST \
    --url https://api.tavily.com/research \
    --header "Authorization: Bearer $TAVILY_API_KEY" \
    --header 'Content-Type: application/json' \
    --header 'x-client-source: claude-code-skill' \
    --data "$JSON_INPUT" 2>&1)

if [ -n "$OUTPUT_FILE" ]; then
    echo "$RESPONSE" > "$OUTPUT_FILE"
    echo "Results saved to: $OUTPUT_FILE"
else
    echo "$RESPONSE"
fi
