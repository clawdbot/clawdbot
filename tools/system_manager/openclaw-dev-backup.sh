#!/usr/bin/env bash
set -euo pipefail

EXPECTED_HOST="openclawdev"
REPO="$HOME/ai/projects/openclaw"
LOCAL_DIR="$HOME/openclaw-dev-backups"

PROD_HOST="${OPENCLAW_BACKUP_HOST:-100.85.36.72}"
PROD_USER="gravesab"
PROD="${PROD_USER}@${PROD_HOST}"
SSH_KEY="$HOME/.ssh/openclaw_dev_backup_ed25519"

REMOTE_FINAL_DIR="/mnt/ai-storage/openclaw-backups/dev"
REMOTE_STAGE_DIR="$HOME/incoming-dev-backups"

STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="openclaw-dev-backup-${STAMP}.tar.gz"
CHECKSUM="${ARCHIVE}.sha256"

LOCAL_ARCHIVE="${LOCAL_DIR}/${ARCHIVE}"
LOCAL_CHECKSUM="${LOCAL_DIR}/${CHECKSUM}"

SSH_OPTIONS=(
    -i "$SSH_KEY"
    -o BatchMode=yes
    -o ConnectTimeout=15
)

cleanup_on_failure() {
    echo
    echo "Backup did not complete successfully."
    echo "Any completed local archive remains in:"
    echo "$LOCAL_DIR"
}
trap cleanup_on_failure ERR

echo "===== OPENCLAW DEV BACKUP ====="
echo "Time: $(date)"
echo

ACTUAL_HOST="$(hostnamectl --static)"
if [ "$ACTUAL_HOST" != "$EXPECTED_HOST" ]; then
    echo "ERROR: This script must run on $EXPECTED_HOST."
    echo "Current host: $ACTUAL_HOST"
    exit 1
fi

if [ ! -d "$REPO/.git" ]; then
    echo "ERROR: OpenClaw repository not found at:"
    echo "$REPO"
    exit 1
fi

if [ ! -f "$SSH_KEY" ]; then
    echo "ERROR: Backup SSH key not found:"
    echo "$SSH_KEY"
    exit 1
fi

mkdir -p "$LOCAL_DIR"

echo "===== REPOSITORY STATUS ====="
cd "$REPO"
echo "Branch: $(git branch --show-current)"
echo "Commit: $(git log -1 --oneline)"
git status --short || true
echo

echo "===== TEST PRODUCTION CONNECTION ====="
ssh "${SSH_OPTIONS[@]}" "$PROD" \
    'test "$(hostnamectl --static)" = "intelmini" && echo "Connected to intelmini"'

echo
echo "===== CHECK DESTINATION ====="
ssh "${SSH_OPTIONS[@]}" "$PROD" "
    set -e
    test -d /mnt/ai-storage
    mountpoint -q /mnt/ai-storage
    mkdir -p '$REMOTE_STAGE_DIR' '$REMOTE_FINAL_DIR'
    test -w '$REMOTE_STAGE_DIR'
    test -w '$REMOTE_FINAL_DIR'
    df -h /mnt/ai-storage
"

echo
echo "===== CREATE LOCAL ARCHIVE ====="
cd "$HOME/ai/projects"

tar \
    --exclude='openclaw/.git' \
    --exclude='openclaw/node_modules' \
    --exclude='openclaw/.venv' \
    --exclude='openclaw/**/.venv' \
    --exclude='openclaw/**/__pycache__' \
    --exclude='openclaw/.pytest_cache' \
    --exclude='openclaw/.mypy_cache' \
    --exclude='openclaw/.ruff_cache' \
    --exclude='openclaw/tmp' \
    --exclude='openclaw/.cache' \
    -czf "$LOCAL_ARCHIVE" \
    openclaw

(cd "$LOCAL_DIR" && sha256sum "$ARCHIVE" > "$CHECKSUM")

ls -lh "$LOCAL_ARCHIVE" "$LOCAL_CHECKSUM"
echo

echo "===== TRANSFER TO PRODUCTION STAGING ====="
scp "${SSH_OPTIONS[@]}" \
    "$LOCAL_ARCHIVE" \
    "$LOCAL_CHECKSUM" \
    "${PROD}:${REMOTE_STAGE_DIR}/"

echo
echo "===== VERIFY AND STORE ON PRODUCTION ====="
ssh "${SSH_OPTIONS[@]}" "$PROD" "
    set -euo pipefail

    cd '$REMOTE_STAGE_DIR'

    sha256sum -c '$CHECKSUM'

    mv '$ARCHIVE' '$REMOTE_FINAL_DIR/$ARCHIVE'
    mv '$CHECKSUM' '$REMOTE_FINAL_DIR/$CHECKSUM'

    cd '$REMOTE_FINAL_DIR'
    sha256sum -c '$CHECKSUM'

    echo
    echo 'Stored files:'
    ls -lh '$ARCHIVE' '$CHECKSUM'

"

echo
echo "===== REMOVE TRANSFERRED LOCAL COPY ====="
rm -f "$LOCAL_ARCHIVE" "$LOCAL_CHECKSUM"

echo
echo "===== BACKUP COMPLETE ====="
echo "Production destination:"
echo "${REMOTE_FINAL_DIR}/${ARCHIVE}"

trap - ERR
