#!/usr/bin/env bash
set -euo pipefail

echo "Scrypted URL: https://127.0.0.1:10443"

HTTP_CODE=$(curl -k -s -o /dev/null -w "%{http_code}" https://127.0.0.1:10443 || true)

echo "HTTP status: $HTTP_CODE"

echo
echo "Docker:"
docker ps --format "{{.Names}} = {{.Status}}" | grep '^scrypted' || echo "scrypted = not running"

echo
echo "Recent plugin status:"
docker logs --tail=80 scrypted 2>&1 \
| grep -Ei 'Core loaded|ONVIF|Snapshot|WebRTC|plugin loaded|error|failed|warn' \
| tail -30
