#!/usr/bin/env bash
set -euo pipefail

version="$(node -p 'require("./package.json").version')"
release_tag="${RELEASE_TAG:-v${version}}"
export RELEASE_TAG="${release_tag}"

echo "release tag: ${RELEASE_TAG}"
git diff --check
pnpm check:temp-path-guardrails
pnpm plugins:sync:check
pnpm release:generated:check
pnpm release:plugins:npm:check -- --selection-mode all-publishable
pnpm release:plugins:clawhub:check -- --selection-mode all-publishable
pnpm build
pnpm ui:build
pnpm release:openclaw:npm:check
