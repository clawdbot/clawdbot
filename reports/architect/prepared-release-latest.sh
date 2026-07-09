#!/bin/bash
set -euo pipefail

cd ~/ai/projects/openclaw

echo "Staging exact Architect files only..."

git add \
  tools/architect/README.md \
  tools/architect/release-readiness.sh \
  tools/architect/prepare-release.sh \
  reports/architect/release-readiness-latest.txt \
  reports/architect/prepared-release-latest.sh

echo
echo "Review staged files:"
git diff --cached --stat

echo
echo "Commit:"
git commit -m "Establish RanchBrain Architect engineering service"

echo
echo "Tag:"
git tag -a ranchbrain-architect-v0.1.0 -m "RanchBrain Architect v0.1.0"

echo
echo "No push is included. Steward approval required before push."
