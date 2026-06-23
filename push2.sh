#!/bin/bash
cd /tmp/fix3-78664
git checkout -q -b rb-fix-78664
echo "branch: $(git branch --show-current)"
echo "=== verify budget is 10328/5185 ==="
grep -E "MAX_PUBLIC_EXPORTS|MAX_PUBLIC_FUNCTION_EXPORTS" scripts/plugin-sdk-surface-report.mjs | head
echo "=== commit ==="
git add -A
git commit -q -m "chore(plugin-sdk): set surface budget to exact actual (10328/5185)

The hook-owned tool schema cache re-export adds exactly one public
export (10328) and one callable export (5185). Regenerated baseline."
echo "head: $(git rev-parse HEAD)"
git fetch prfork tool-schema-cache-pr3 2>&1 | tail -1
OLD=$(git rev-parse prfork/tool-schema-cache-pr3)
git push --force-with-lease=tool-schema-cache-pr3:$OLD prfork HEAD:tool-schema-cache-pr3 2>&1 | tail -3
