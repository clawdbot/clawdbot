# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:e8e2e91b1378f83c5b2dd15f0247f34110e2fe895f6ca7719dbb780f929368eb

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN --mount=type=cache,id=openclaw-cleanup-smoke-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=openclaw-cleanup-smoke-apt-lists,target=/var/lib/apt,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY openclaw.mjs ./
COPY ui/package.json ./ui/package.json
COPY packages ./packages
COPY extensions ./extensions
COPY patches ./patches
COPY scripts/postinstall-bundled-plugins.mjs scripts/preinstall-package-manager-warning.mjs scripts/npm-runner.mjs scripts/windows-cmd-helpers.mjs ./scripts/
COPY scripts/lib/bundled-runtime-deps-install.mjs ./scripts/lib/bundled-runtime-deps-install.mjs
COPY scripts/lib/package-dist-imports.mjs ./scripts/lib/package-dist-imports.mjs
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
  corepack enable \
  && if ! pnpm install --frozen-lockfile >/tmp/openclaw-cleanup-pnpm-install.log 2>&1; then \
    cat /tmp/openclaw-cleanup-pnpm-install.log; \
    exit 1; \
  fi

COPY . .
COPY --chmod=755 scripts/docker/cleanup-smoke/run.sh /usr/local/bin/openclaw-cleanup-smoke

ENTRYPOINT ["/usr/local/bin/openclaw-cleanup-smoke"]
