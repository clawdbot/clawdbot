#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_DIR="/home/gravesab/ai/projects/openclaw"
BACKUP_ROOT="$OPENCLAW_DIR/tools/dashboard/backups/propertymanager_app_backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$BACKUP_ROOT/backup-$STAMP"

mkdir -p "$BACKUP_DIR"

cp "$OPENCLAW_DIR/tools/dashboard/app.py" "$BACKUP_DIR/app.py"
cp -a "$OPENCLAW_DIR/tools/property_manager" "$BACKUP_DIR/property_manager"

cat > "$BACKUP_DIR/README.txt" <<EOF
PropertyManager / Dashboard backup
Created: $STAMP
Source:
- $OPENCLAW_DIR/tools/dashboard/app.py
- $OPENCLAW_DIR/tools/property_manager
EOF

echo "Dashboard/property backup complete."
echo "$BACKUP_DIR"
