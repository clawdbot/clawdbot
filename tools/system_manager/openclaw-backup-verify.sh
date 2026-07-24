#!/usr/bin/env bash
set -uo pipefail

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/ai/projects/openclaw}"
BACKUP_ROOT="${BACKUP_ROOT:-/mnt/ai-storage/openclaw-backups}"
REPORT_DIR="$OPENCLAW_DIR/reports/system_manager"
REPORT_FILE="$REPORT_DIR/openclaw_backup_verification_report.txt"
JSON_FILE="$REPORT_DIR/openclaw_backup_verification_status.json"
LOCK_FILE="/tmp/openclaw-backup-verification.lock"

mkdir -p "$REPORT_DIR"

exec 9>"$LOCK_FILE"

if ! flock -n 9; then
    echo "Another backup verification is already running."
    exit 0
fi

TMP_REPORT="$(mktemp)"
TMP_JSON="$(mktemp)"

cleanup() {
    rm -f "$TMP_REPORT" "$TMP_JSON"
}
trap cleanup EXIT

overall_status="healthy"
verified_count=0
warning_count=0
failed_count=0

json_entries=()

human_size() {
    local file="$1"

    if command -v numfmt >/dev/null 2>&1; then
        stat -c '%s' "$file" |
            numfmt --to=iec-i --suffix=B
    else
        stat -c '%s bytes' "$file"
    fi
}

find_latest() {
    local directory="$1"
    local pattern="$2"

    find "$directory" \
        -maxdepth 1 \
        -type f \
        -name "$pattern" \
        -printf '%T@|%p\n' 2>/dev/null |
        sort -nr |
        head -1 |
        cut -d'|' -f2-
}

json_escape() {
    python3 -c '
import json
import sys
print(json.dumps(sys.stdin.read().rstrip("\n")))
'
}

verify_backup() {
    local label="$1"
    local directory="$2"
    local pattern="$3"

    local latest=""
    local filename=""
    local size=""
    local modified=""
    local result_status=""
    local result_message=""
    local checksum_status="not_available"
    local checksum_message="No checksum file found."
    local checksum_file=""

    echo
    echo "--------------------------------------------------"
    echo "$label"
    echo "--------------------------------------------------"

    if [ ! -d "$directory" ]; then
        echo "Status: FAILED"
        echo "Reason: Backup directory does not exist."
        echo "Directory: $directory"

        result_status="failed"
        result_message="Backup directory does not exist."
        failed_count=$((failed_count + 1))
        overall_status="critical"

        append_json_entry \
            "$label" \
            "$result_status" \
            "" \
            "$directory" \
            "" \
            "" \
            "$result_message" \
            "$checksum_status" \
            "$checksum_message"

        return
    fi

    latest="$(find_latest "$directory" "$pattern")"

    if [ -z "$latest" ]; then
        echo "Status: FAILED"
        echo "Reason: No matching backup found."
        echo "Directory: $directory"
        echo "Pattern: $pattern"

        result_status="failed"
        result_message="No matching backup found."
        failed_count=$((failed_count + 1))
        overall_status="critical"

        append_json_entry \
            "$label" \
            "$result_status" \
            "" \
            "$directory" \
            "" \
            "" \
            "$result_message" \
            "$checksum_status" \
            "$checksum_message"

        return
    fi

    filename="$(basename "$latest")"
    size="$(human_size "$latest")"
    modified="$(date -d "@$(stat -c '%Y' "$latest")" '+%Y-%m-%d %I:%M:%S %p %Z')"

    echo "File: $latest"
    echo "Size: $size"
    echo "Modified: $modified"

    echo
    echo "Checking gzip stream..."

    if ! gzip -t "$latest" 2>/tmp/openclaw-backup-gzip-error.txt; then
        result_status="failed"
        result_message="gzip integrity test failed."

        echo "gzip test: FAILED"
        sed -n '1,10p' /tmp/openclaw-backup-gzip-error.txt || true
    else
        echo "gzip test: PASSED"

        echo
        echo "Checking tar archive listing..."

        if ! tar -tzf "$latest" >/dev/null 2>/tmp/openclaw-backup-tar-error.txt; then
            result_status="failed"
            result_message="tar archive listing failed."

            echo "tar test: FAILED"
            sed -n '1,10p' /tmp/openclaw-backup-tar-error.txt || true
        else
            result_status="verified"
            result_message="Archive passed gzip and tar validation."
            echo "tar test: PASSED"
        fi
    fi

    rm -f \
        /tmp/openclaw-backup-gzip-error.txt \
        /tmp/openclaw-backup-tar-error.txt

    for candidate in \
        "${latest}.sha256" \
        "${latest%.tar.gz}.sha256" \
        "${directory}/${filename}.sha256"; do

        if [ -f "$candidate" ]; then
            checksum_file="$candidate"
            break
        fi
    done

    echo
    echo "Checking SHA-256..."

    if [ -n "$checksum_file" ]; then
        checksum_dir="$(dirname "$checksum_file")"
        checksum_name="$(basename "$checksum_file")"

        if (
            cd "$checksum_dir"
            sha256sum -c "$checksum_name" >/tmp/openclaw-checksum-result.txt 2>&1
        ); then
            checksum_status="verified"
            checksum_message="SHA-256 checksum matched."
            echo "SHA-256: PASSED"
        else
            checksum_status="failed"
            checksum_message="SHA-256 checksum did not match."
            result_status="failed"
            result_message="Archive validation or checksum verification failed."
            echo "SHA-256: FAILED"
            cat /tmp/openclaw-checksum-result.txt || true
        fi
    else
        checksum_status="not_available"
        checksum_message="No checksum file found; archive structure was still tested."
        echo "SHA-256: NOT AVAILABLE"
    fi

    rm -f /tmp/openclaw-checksum-result.txt

    case "$result_status" in
        verified)
            verified_count=$((verified_count + 1))
            echo
            echo "Status: VERIFIED"
            ;;
        failed)
            failed_count=$((failed_count + 1))
            overall_status="critical"
            echo
            echo "Status: FAILED"
            ;;
        *)
            warning_count=$((warning_count + 1))

            if [ "$overall_status" = "healthy" ]; then
                overall_status="warning"
            fi

            echo
            echo "Status: WARNING"
            ;;
    esac

    append_json_entry \
        "$label" \
        "$result_status" \
        "$filename" \
        "$directory" \
        "$size" \
        "$modified" \
        "$result_message" \
        "$checksum_status" \
        "$checksum_message"
}

append_json_entry() {
    local label="$1"
    local status="$2"
    local filename="$3"
    local directory="$4"
    local size="$5"
    local modified="$6"
    local message="$7"
    local checksum_status="$8"
    local checksum_message="$9"

    local entry

    entry="$(
        LABEL="$label" \
        STATUS="$status" \
        FILENAME="$filename" \
        DIRECTORY="$directory" \
        SIZE="$size" \
        MODIFIED="$modified" \
        MESSAGE="$message" \
        CHECKSUM_STATUS="$checksum_status" \
        CHECKSUM_MESSAGE="$checksum_message" \
        python3 - <<'PY'
import json
import os

print(json.dumps({
    "label": os.environ["LABEL"],
    "status": os.environ["STATUS"],
    "filename": os.environ["FILENAME"],
    "directory": os.environ["DIRECTORY"],
    "size": os.environ["SIZE"],
    "modified": os.environ["MODIFIED"],
    "message": os.environ["MESSAGE"],
    "checksum_status": os.environ["CHECKSUM_STATUS"],
    "checksum_message": os.environ["CHECKSUM_MESSAGE"],
}))
PY
    )"

    json_entries+=("$entry")
}

{
    echo "OpenClaw Backup Verification Report"
    echo "Checked At: $(date '+%A, %B %d, %Y %I:%M:%S %p %Z')"
    echo "Host: $(hostname)"
    echo "Backup Root: $BACKUP_ROOT"

    verify_backup \
        "OpenClaw Production" \
        "$BACKUP_ROOT" \
        "openclaw-checkpoint-*.tar.gz"

    verify_backup \
        "OpenClaw Development" \
        "$BACKUP_ROOT/dev" \
        "openclaw-dev-backup-*.tar.gz"

    verify_backup \
        "Dashboard and PropertyManager" \
        "$BACKUP_ROOT/dashboard-property-backups" \
        "dashboard-property-backup-*.tar.gz"

    echo
    echo "=================================================="
    echo "SUMMARY"
    echo "=================================================="
    echo "Overall Status: $overall_status"
    echo "Verified Backups: $verified_count"
    echo "Warnings: $warning_count"
    echo "Failed Backups: $failed_count"

} > "$TMP_REPORT"

cat "$TMP_REPORT"
mv "$TMP_REPORT" "$REPORT_FILE"

{
    printf '{\n'
    printf '  "checked_at": %s,\n' \
        "$(date '+%Y-%m-%d %H:%M:%S %Z' | json_escape)"
    printf '  "host": %s,\n' \
        "$(hostname | json_escape)"
    printf '  "overall_status": %s,\n' \
        "$(printf '%s' "$overall_status" | json_escape)"
    printf '  "verified_count": %d,\n' "$verified_count"
    printf '  "warning_count": %d,\n' "$warning_count"
    printf '  "failed_count": %d,\n' "$failed_count"
    printf '  "backups": [\n'

    for index in "${!json_entries[@]}"; do
        printf '    %s' "${json_entries[$index]}"

        if [ "$index" -lt "$((${#json_entries[@]} - 1))" ]; then
            printf ','
        fi

        printf '\n'
    done

    printf '  ]\n'
    printf '}\n'
} > "$TMP_JSON"

mv "$TMP_JSON" "$JSON_FILE"

echo
echo "Text report:"
echo "$REPORT_FILE"

echo
echo "JSON status:"
echo "$JSON_FILE"

if [ "$failed_count" -gt 0 ]; then
    exit 2
fi

exit 0
