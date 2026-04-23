#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

pnpm test:docker:live-build
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-models
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-gateway

export OPENCLAW_DOCKER_E2E_IMAGE="${OPENCLAW_DOCKER_E2E_IMAGE:-openclaw-docker-e2e:local}"
pnpm test:docker:e2e-build

OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openwebui
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:onboard
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:npm-onboard-channel-agent
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:gateway-network
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-web-search-minimal
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:mcp-channels
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:pi-bundle-mcp-tools
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:cron-mcp-cleanup
pnpm test:docker:qr
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:doctor-switch
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugin-update
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:config-reload
OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:bundled-channel-deps
pnpm test:docker:cleanup
