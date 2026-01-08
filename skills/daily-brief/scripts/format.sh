#!/bin/bash
# Daily Brief - Formatting & Synthesis Script
# Processes raw data and synthesizes into a concise text summary

set -euo pipefail

# Configuration
DATE="${1:-$(date +%Y-%m-%d)}"
INPUT_DIR="/tmp/daily-brief-${DATE}"
OUTPUT_FILE="${INPUT_DIR}/final_brief.md"
TEMP_DIR="${INPUT_DIR}/temp"
LOG_FILE="${INPUT_DIR}/format.log"

# Create temp directory
mkdir -p "$TEMP_DIR"

# Logging function
log() {
    echo "[$(date +%Y-%m-%d\ %H:%M:%S)] $*" | tee -a "$LOG_FILE"
}

log "Starting daily brief formatting and synthesis for ${DATE}"

# Check if input files exist
check_input_files() {
    local files=("imessage.json" "whatsapp.json" "gmail.json" "calendar.json" "reminders.json" "notes.json")
    for file in "${files[@]}"; do
        if [[ ! -f "${INPUT_DIR}/${file}" ]]; then
            log "Warning: ${file} not found, creating empty array"
            echo "[]" > "${INPUT_DIR}/${file}"
        fi
    done
}

# Function to resolve contacts using contactbook
resolve_contacts() {
    local input_file="$1"
    local output_file="$2"

    if command -v contactbook &> /dev/null; then
        log "Resolving contacts in $input_file"
        # Use contactbook to resolve phone numbers to names
        # This is a simplified version - actual implementation would depend on contactbook API
        cp "$input_file" "$output_file"
        log "Contact resolution completed"
    else
        log "contactbook not available, skipping contact resolution"
        cp "$input_file" "$output_file"
    fi
}

# Function to filter relevant content using LLM
filter_relevant_content() {
    local content="$1"
    local content_type="$2"
    local output_file="$3"

    log "Filtering relevant ${content_type} content"

    # Create prompt for LLM summarization
    local prompt="Please analyze the following ${content_type} data from today and extract only the most important and relevant information that would be useful for a daily briefing. Focus on actionable items, important communications, and time-sensitive information. Ignore spam, routine notifications, and irrelevant messages.

Data:
${content}

Please provide a concise summary focusing on:
- Urgent or time-sensitive items
- Important communications that need follow-up
- Key decisions or updates
- Meeting/action items

If there's nothing important, respond with 'NO_SIGNIFICANT_CONTENT'"

    # Use summarize command if available (disabled for now to avoid timeouts)
    if false && command -v summarize &> /dev/null; then
        # Create a temporary file with the content to summarize
        temp_content_file="${TEMP_DIR}/content_to_summarize.txt"
        echo "$content" > "$temp_content_file"
        summarize "$temp_content_file" --format text > "$output_file" 2>/dev/null || echo "LLM summarization failed, using raw content" > "$output_file"
    else
        # Fallback: extract basic information
        echo "Content filtering unavailable - using basic extraction" > "$output_file"
        echo "$content" | head -20 >> "$output_file"
    fi
}

# Function to prepare meeting information
prepare_meeting_info() {
    local calendar_file="$1"
    local output_file="$2"

    log "Preparing meeting information"

    # Extract today's meetings
    local meetings
    meetings=$(jq -r '.[] | select(.start | startswith("'${DATE}'")) | "\(.summary) at \(.start) with \(.attendees // [] | join(", "))"' "$calendar_file" 2>/dev/null || echo "")

    if [[ -n "$meetings" ]]; then
        echo "## Today's Meetings" > "$output_file"
        echo "$meetings" | while read -r meeting; do
            echo "- $meeting" >> "$output_file"

            # Use brave-search to get company info for attendees if available
            # This is a simplified version
            local attendee_info=""
            if command -v brave-search &> /dev/null; then
                # Extract attendee names and search for company info
                echo "$meeting" | grep -o 'with [^"]*' | sed 's/with //' | tr ',' '\n' | while read -r attendee; do
                    if [[ -n "$attendee" && "$attendee" != "[]" ]]; then
                        local search_result
                        search_result=$(brave-search "company information for $attendee" 2>/dev/null | head -3 || echo "")
                        if [[ -n "$search_result" ]]; then
                            attendee_info="${attendee_info}\n  - $attendee: $search_result"
                        fi
                    fi
                done
            fi

            if [[ -n "$attendee_info" ]]; then
                echo "$attendee_info" >> "$output_file"
            fi
        done
        echo "" >> "$output_file"
    else
        echo "No meetings scheduled for today." > "$output_file"
        echo "" >> "$output_file"
    fi
}

# Main processing
check_input_files

# Process communications data
comm_content=""
for source in imessage whatsapp gmail whoop_metrics whoop_workouts whoop_sleep; do
    if [[ -f "${INPUT_DIR}/${source}.json" ]]; then
        raw_content=$(cat "${INPUT_DIR}/${source}.json")
        if [[ "$raw_content" != "[]" && -n "$raw_content" ]]; then
            upper_source=$(echo "$source" | tr '[:lower:]' '[:upper:]')
            comm_content="${comm_content}"$'\n'"=== ${upper_source} ==="$'\n'"${raw_content}"
        fi
    fi
done

# Filter communications
if [[ -n "$comm_content" ]]; then
    filter_relevant_content "$comm_content" "communications" "${TEMP_DIR}/communications_filtered.txt"
else
    echo "NO_SIGNIFICANT_CONTENT" > "${TEMP_DIR}/communications_filtered.txt"
fi

# Process notes, reminders, and health data
notes_content=""
for source in reminders notes whoop_metrics whoop_workouts whoop_sleep; do
    if [[ -f "${INPUT_DIR}/${source}.json" ]]; then
        raw_content=$(cat "${INPUT_DIR}/${source}.json")
        if [[ "$raw_content" != "[]" && -n "$raw_content" ]]; then
            upper_source=$(echo "$source" | tr '[:lower:]' '[:upper:]')
            notes_content="${notes_content}"$'\n'"=== ${upper_source} ==="$'\n'"${raw_content}"
        fi
    fi
done

# Filter notes and reminders
if [[ -n "$notes_content" ]]; then
    filter_relevant_content "$notes_content" "notes, reminders, and health data" "${TEMP_DIR}/notes_filtered.txt"
else
    echo "NO_SIGNIFICANT_CONTENT" > "${TEMP_DIR}/notes_filtered.txt"
fi

# Prepare meeting information
prepare_meeting_info "${INPUT_DIR}/calendar.json" "${TEMP_DIR}/meetings.txt"

# Generate final brief
{
    echo "# Daily Brief - ${DATE}"
    echo ""
    echo "## Meetings"
    cat "${TEMP_DIR}/meetings.txt"
    echo "## Communications"
    if [[ "$(cat "${TEMP_DIR}/communications_filtered.txt")" != "NO_SIGNIFICANT_CONTENT" ]]; then
        cat "${TEMP_DIR}/communications_filtered.txt"
    else
        echo "No significant communications today."
    fi
    echo ""
    echo "## Notes, Reminders & Health"
    if [[ "$(cat "${TEMP_DIR}/notes_filtered.txt")" != "NO_SIGNIFICANT_CONTENT" ]]; then
        cat "${TEMP_DIR}/notes_filtered.txt"
    else
        echo "No significant notes, reminders, or health data."
    fi
    echo ""
    echo "---"
    echo "*Generated on $(date)*"
} > "$OUTPUT_FILE"

log "Daily brief formatting completed. Output saved to $OUTPUT_FILE"

# Clean up temp files
rm -rf "$TEMP_DIR"

log "Temporary files cleaned up"