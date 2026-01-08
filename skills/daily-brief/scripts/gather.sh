#!/bin/bash
# Daily Brief - Data Gathering Script
# Collects information from various communication channels and sources

set -uo pipefail

# Configuration
DATE="${1:-$(date +%Y-%m-%d)}"
OUTPUT_DIR="/tmp/daily-brief-${DATE}"
LOG_FILE="${OUTPUT_DIR}/gather.log"

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Logging function
log() {
    echo "[$(date +%Y-%m-%d\ %H:%M:%S)] $*" | tee -a "$LOG_FILE"
}

log "Starting daily brief data gathering for ${DATE}"

# Function to run a command and capture output
run_command() {
    local cmd="$1"
    local output_file="$2"
    local description="$3"

    log "Running: $description"
    if eval "$cmd" > "$output_file" 2>&1; then
        log "✓ $description completed successfully"
        return 0
    else
        log "✗ $description failed with exit code $?"
        return 1
    fi
}

# Gather iMessage data
if command -v imsg &> /dev/null; then
    run_command "imsg history --chat all --limit 50" \
                "${OUTPUT_DIR}/imessage.txt" \
                "iMessage data collection"
    # Convert to JSON format
    if [[ -f "${OUTPUT_DIR}/imessage.txt" ]]; then
        # Simple conversion to JSON array (placeholder - would need proper parsing)
        echo "[{\"source\": \"imessage\", \"content\": \"$(cat "${OUTPUT_DIR}/imessage.txt" | tr '\n' ' ' | sed 's/"/\\"/g')\"}]" > "${OUTPUT_DIR}/imessage.json"
    else
        echo "[]" > "${OUTPUT_DIR}/imessage.json"
    fi
else
    log "⚠ imsg command not found, skipping iMessage data"
    echo "[]" > "${OUTPUT_DIR}/imessage.json"
fi

# Gather WhatsApp data
if command -v wacli &> /dev/null; then
    run_command "wacli messages --since '${DATE}' --format json" \
                "${OUTPUT_DIR}/whatsapp.json" \
                "WhatsApp data collection"
else
    log "⚠ wacli command not found, skipping WhatsApp data"
    echo "[]" > "${OUTPUT_DIR}/whatsapp.json"
fi

# Gather Gmail and Calendar data
if command -v gog &> /dev/null; then
    # Gmail messages
    run_command "gog gmail messages --since '${DATE}' --format json" \
                "${OUTPUT_DIR}/gmail.json" \
                "Gmail data collection"

    # Calendar events
    run_command "gog calendar events --date '${DATE}' --format json" \
                "${OUTPUT_DIR}/calendar.json" \
                "Calendar data collection"
else
    log "⚠ gog command not found, skipping Gmail/Calendar data"
    echo "[]" > "${OUTPUT_DIR}/gmail.json"
    echo "[]" > "${OUTPUT_DIR}/calendar.json"
fi

# Gather Braindump data (Reminders and Notes)
if command -v braindump &> /dev/null; then
    # Reminders
    run_command "braindump reminders --format json" \
                "${OUTPUT_DIR}/reminders.json" \
                "Reminders data collection"

    # Notes
    run_command "braindump notes --since '${DATE}' --format json" \
                "${OUTPUT_DIR}/notes.json" \
                "Notes data collection"
else
    log "⚠ braindump command not found, skipping Reminders/Notes data"
    echo "[]" > "${OUTPUT_DIR}/reminders.json"
    echo "[]" > "${OUTPUT_DIR}/notes.json"
fi

# Gather Whoop data (health and fitness metrics)
if command -v whoop &> /dev/null; then
    # Today's health metrics
    run_command "whoop metrics --date '${DATE}' --format json" \
                "${OUTPUT_DIR}/whoop_metrics.json" \
                "Whoop health metrics collection"

    # Recent workouts
    run_command "whoop workouts --since '${DATE}' --format json" \
                "${OUTPUT_DIR}/whoop_workouts.json" \
                "Whoop workout data collection"

    # Sleep data
    run_command "whoop sleep --date '${DATE}' --format json" \
                "${OUTPUT_DIR}/whoop_sleep.json" \
                "Whoop sleep data collection"
else
    log "⚠ whoop command not found, skipping Whoop health data"
    echo "[]" > "${OUTPUT_DIR}/whoop_metrics.json"
    echo "[]" > "${OUTPUT_DIR}/whoop_workouts.json"
    echo "[]" > "${OUTPUT_DIR}/whoop_sleep.json"
fi

# Create a summary of gathered data
{
    echo "# Data Gathering Summary - ${DATE}"
    echo ""
    echo "## Files Generated:"
    ls -la "$OUTPUT_DIR"/*.json | while read -r line; do
        echo "- $line"
    done
    echo ""
    echo "## Data Sources:"
    echo "- iMessage: $(jq '. | length' "${OUTPUT_DIR}/imessage.json" 2>/dev/null || echo 'N/A') messages"
    echo "- WhatsApp: $(jq '. | length' "${OUTPUT_DIR}/whatsapp.json" 2>/dev/null || echo 'N/A') messages"
    echo "- Gmail: $(jq '. | length' "${OUTPUT_DIR}/gmail.json" 2>/dev/null || echo 'N/A') messages"
    echo "- Calendar: $(jq '. | length' "${OUTPUT_DIR}/calendar.json" 2>/dev/null || echo 'N/A') events"
    echo "- Reminders: $(jq '. | length' "${OUTPUT_DIR}/reminders.json" 2>/dev/null || echo 'N/A') items"
    echo "- Notes: $(jq '. | length' "${OUTPUT_DIR}/notes.json" 2>/dev/null || echo 'N/A') notes"
    echo "- Whoop Metrics: $(jq '. | length' "${OUTPUT_DIR}/whoop_metrics.json" 2>/dev/null || echo 'N/A') entries"
    echo "- Whoop Workouts: $(jq '. | length' "${OUTPUT_DIR}/whoop_workouts.json" 2>/dev/null || echo 'N/A') workouts"
    echo "- Whoop Sleep: $(jq '. | length' "${OUTPUT_DIR}/whoop_sleep.json" 2>/dev/null || echo 'N/A') records"
} > "${OUTPUT_DIR}/data_summary.md"

log "Data gathering completed. Summary saved to ${OUTPUT_DIR}/data_summary.md"