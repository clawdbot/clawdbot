#!/bin/bash
set -euo pipefail

BASE="$HOME/ai/projects/openclaw"
OUT="$BASE/reports/engineering_assistant/prepared-release-latest.sh"

mkdir -p "$(dirname "$OUT")"

cat > "$OUT" <<'SCRIPT'
#!/bin/bash
set -euo pipefail

cd ~/ai/projects/openclaw

echo "Reviewing Git status..."
git status --short

echo
echo "Suggested safe add list:"
git add ranchbrain tools/engineering_assistant reports/engineering_assistant

echo
echo "Commit:"
git commit -m "Establish RanchBrain engineering assistant and asset registry"

echo
echo "Tag:"
git tag -a ranchbrain-foundation-v1.0.0 -m "RanchBrain Foundation v1.0.0"

echo
echo "No push is included. Push manually only after review."
SCRIPT

chmod +x "$OUT"

echo "Prepared release script:"
echo "$OUT"
echo
echo "Review it before running:"
echo "cat $OUT"
