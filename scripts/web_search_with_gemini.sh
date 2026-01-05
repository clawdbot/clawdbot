#!/bin/bash

# Ensure fnm/node PATH is available for gemini CLI
export PATH="/home/almaz/.local/share/fnm/node-versions/v22.21.1/installation/bin:$PATH"

# Default values
MODEL="gemini-3-flash-preview"
OUTPUT_FORMAT="json"

# Parse arguments
QUERY=""
while [[ $# -gt 0 ]]; do
  case $1 in
    -m|--model)
      MODEL="$2"
      shift 2
      ;;
    -o|--output-format)
      OUTPUT_FORMAT="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [options] 'Your question'"
      echo "Options:"
      echo "  -m, --model <model>          Model to use (default: $MODEL)"
      echo "  -o, --output-format <format> Output format (default: $OUTPUT_FORMAT)"
      exit 0
      ;;
    *)
      if [ -z "$QUERY" ]; then
        QUERY="$1"
      else
        QUERY="$QUERY $1"
      fi
      shift
      ;;
  esac
done

if [ -z "$QUERY" ]; then
  echo "Error: No query provided."
  echo "Usage: $0 [options] 'Your question'"
  exit 1
fi

# Load the specialized prompt tail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PROMPT_FILE="$PROJECT_ROOT/prompts/web-search-tail.yaml"
if [ ! -f "$PROMPT_FILE" ]; then
  echo "Error: Prompt file $PROMPT_FILE not found."
  exit 1
fi

# Extract the prompt_tail value - this TELLS gemini to use web search
TAIL=$(awk '/prompt_tail: \|/{flag=1; next} flag{print; exit}' "$PROMPT_FILE" | sed 's/^  //')

if [ -z "$TAIL" ]; then
  TAIL=$(grep "prompt_tail:" "$PROMPT_FILE" | sed 's/prompt_tail: //' | sed 's/^"//;s/"$//')
fi

# Combine query with the web search instruction
FULL_PROMPT="$QUERY $TAIL"

# Execute gemini CLI using positional argument (one-shot mode)
# IMPORTANT: Use "prompt" not -p to avoid interactive mode
exec gemini "$FULL_PROMPT" -m "$MODEL" --output-format "$OUTPUT_FORMAT"
