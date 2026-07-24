#!/usr/bin/env bash
set -euo pipefail

BASE="/home/gravesab/ai/projects/openclaw"
OUT="$BASE/tools/property_manager/maintenance_log.csv"
BACKUP_DIR="$BASE/tools/property_manager/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

if [ -f "$OUT" ]; then
  cp -a "$OUT" "$BACKUP_DIR/maintenance_log.csv.backup.postgres-export-$STAMP"
fi

docker exec postgres psql -U openclaw -d openclaw -At -F',' -c "
COPY (
  SELECT area, item, last_done::date, warning_days, critical_days
  FROM propertymanager.maintenance_tasks
  WHERE is_active = true
  ORDER BY area, item
) TO STDOUT WITH CSV HEADER;
" > "$OUT"

echo "Exported PostgreSQL PropertyManager tasks to:"
echo "$OUT"
echo
echo "Rows:"
tail -n +2 "$OUT" | wc -l
