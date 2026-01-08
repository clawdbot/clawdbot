#!/bin/bash
# Daily Brief - Voice Generation Script
# Converts text brief to speech using ElevenLabsKit

set -euo pipefail

# Load environment variables
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -f "${SKILL_DIR}/.env" ]]; then
    source "${SKILL_DIR}/.env"
fi

# Configuration
DATE="${1:-$(date +%Y-%m-%d)}"
INPUT_DIR="/tmp/daily-brief-${DATE}"
INPUT_FILE="${INPUT_DIR}/final_brief.md"
OUTPUT_FILE="${INPUT_DIR}/daily-brief.mp3"
LOG_FILE="${INPUT_DIR}/voice.log"

# Default values
ELEVENLABS_BIN="${ELEVENLABS_BIN:-$HOME/Developer/ElevenLabsKit/Examples/ElevenLabsKitCLI/.build/release/ElevenLabsKitCLI}"
VOICE_ID="${DAILY_BRIEF_DEFAULT_VOICE:-Roger}"
FORMAT="${ELEVENLABS_FORMAT:-mp3_44100_128}"

# Logging function
log() {
    echo "[$(date +%Y-%m-%d\ %H:%M:%S)] $*" | tee -a "$LOG_FILE"
}

log "Starting voice generation for daily brief ${DATE}"

# Check if input file exists
if [[ ! -f "$INPUT_FILE" ]]; then
    log "Error: Input file $INPUT_FILE does not exist"
    exit 1
fi

# Check if ElevenLabs binary exists
if [[ ! -f "$ELEVENLABS_BIN" ]]; then
    log "Error: ElevenLabs CLI binary not found at $ELEVENLABS_BIN"
    log "Please ensure ElevenLabsKitCLI is built and ELEVENLABS_BIN is set correctly"
    exit 1
fi

# Sanitize text for TTS (remove markdown formatting that might cause issues)
sanitize_text() {
    local input_file="$1"
    local output_file="$2"

    log "Sanitizing text for TTS"

    sed -e 's/^#* //' \
        -e 's/\[.*\](.*)//g' \
        -e 's/\*\*//g' \
        -e 's/\*//g' \
        -e 's/`//g' \
        -e 's/===*//g' \
        -e 's/---*//g' \
        -e '/^$/d' \
        "$input_file" > "$output_file"
}

# Create sanitized text file
SANITIZED_FILE="${INPUT_DIR}/brief_sanitized.txt"
sanitize_text "$INPUT_FILE" "$SANITIZED_FILE"

# Check if the sanitized text is not empty
if [[ ! -s "$SANITIZED_FILE" ]]; then
    log "Error: Sanitized text file is empty"
    exit 1
fi

log "Generating voice using ElevenLabs CLI"
log "Voice: $VOICE_ID"
log "Format: $FORMAT"
log "Input: $SANITIZED_FILE"
log "Output: $OUTPUT_FILE"

# Generate speech using ElevenLabs CLI
if "$ELEVENLABS_BIN" speak \
    --voice "$VOICE_ID" \
    --format "$FORMAT" \
    --output "$OUTPUT_FILE" \
    --no-play \
    --no-stream \
    "$(cat "$SANITIZED_FILE")"; then

    log "✓ Voice generation completed successfully"
    log "Output file: $OUTPUT_FILE"
    log "File size: $(du -h "$OUTPUT_FILE" | cut -f1)"

    # Clean up sanitized file
    rm -f "$SANITIZED_FILE"

else
    log "✗ Voice generation failed with exit code $?"
    log "Check the ElevenLabs API key and voice ID configuration"
    exit 1
fi

log "Voice generation pipeline completed"