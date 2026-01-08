#!/bin/bash
# Daily Brief - Main Orchestrator Script
# Runs the complete daily brief pipeline: gather -> format -> voice

set -euo pipefail

# Load environment variables
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -f "${SKILL_DIR}/.env" ]]; then
    source "${SKILL_DIR}/.env"
fi

# Configuration
DATE="${1:-$(date +%Y-%m-%d)}"
BASE_DIR="/tmp/daily-brief-${DATE}"
LOG_FILE="${BASE_DIR}/brief.log"

# Script paths
GATHER_SCRIPT="${SCRIPT_DIR}/gather.sh"
FORMAT_SCRIPT="${SCRIPT_DIR}/format.sh"
VOICE_SCRIPT="${SCRIPT_DIR}/voice.sh"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo -e "[$(date +%Y-%m-%d\ %H:%M:%S)] $*" | tee -a "$LOG_FILE"
}

# Success logging
success() {
    log "${GREEN}✓${NC} $1"
}

# Warning logging
warning() {
    log "${YELLOW}⚠${NC} $1"
}

# Error logging
error() {
    log "${RED}✗${NC} $1"
}

# Function to run a step with timing
run_step() {
    local step_name="$1"
    local script_path="$2"
    local step_desc="$3"

    log "${BLUE}Starting ${step_name}:${NC} ${step_desc}"

    local start_time=$(date +%s)

    if [[ -f "$script_path" ]]; then
        if bash "$script_path" "$DATE" 2>&1; then
            local end_time=$(date +%s)
            local duration=$((end_time - start_time))
            success "${step_name} completed in ${duration}s"
            return 0
        else
            error "${step_name} failed (exit code: $?)"
            return 1
        fi
    else
        error "${step_name} script not found: ${script_path}"
        return 1
    fi
}

# Main execution
log "=== Daily Brief Pipeline Started ==="
log "Date: ${DATE}"
log "Output Directory: ${BASE_DIR}"
log ""

# Step 1: Data Gathering
if run_step "Data Gathering" "$GATHER_SCRIPT" "Collecting data from iMessage, WhatsApp, Gmail, Calendar, Reminders, and Notes"; then
    # Check if we have any data
    if [[ -f "${BASE_DIR}/data_summary.md" ]]; then
        log "Data summary:"
        cat "${BASE_DIR}/data_summary.md" | while read -r line; do
            log "  $line"
        done
    fi
else
    error "Data gathering failed. Cannot proceed with formatting."
    exit 1
fi

log ""

# Step 2: Formatting & Synthesis
if run_step "Formatting" "$FORMAT_SCRIPT" "Processing and synthesizing data into readable brief"; then
    # Check output
    if [[ -f "${BASE_DIR}/final_brief.md" ]]; then
        log "Brief preview (first 10 lines):"
        head -10 "${BASE_DIR}/final_brief.md" | while read -r line; do
            log "  $line"
        done
        log "  ..."
    else
        warning "No final brief file generated"
    fi
else
    error "Formatting failed. Cannot proceed with voice generation."
    exit 1
fi

log ""

# Step 3: Voice Generation
if run_step "Voice Generation" "$VOICE_SCRIPT" "Converting brief to speech using ElevenLabs"; then
    # Check output
    if [[ -f "${BASE_DIR}/daily-brief.mp3" ]]; then
        file_size=$(du -h "${BASE_DIR}/daily-brief.mp3" | cut -f1)
        success "Audio file generated: ${BASE_DIR}/daily-brief.mp3 (${file_size})"
    else
        warning "No audio file generated"
    fi
else
    warning "Voice generation failed. Brief text is still available."
    # Don't exit here as text brief is still valuable
fi

log ""

# Final summary
log "=== Daily Brief Pipeline Completed ==="
log "Files generated:"

# List all generated files
if [[ -d "$BASE_DIR" ]]; then
    find "$BASE_DIR" -type f -name "*.md" -o -name "*.mp3" -o -name "*.json" | sort | while read -r file; do
        size=$(du -h "$file" | cut -f1)
        log "  - $(basename "$file") (${size})"
    done
fi

log ""
log "Daily brief for ${DATE} is ready!"
log "Text brief: ${BASE_DIR}/final_brief.md"
if [[ -f "${BASE_DIR}/daily-brief.mp3" ]]; then
    log "Audio brief: ${BASE_DIR}/daily-brief.mp3"
fi

log ""
log "=== Pipeline finished at $(date) ==="