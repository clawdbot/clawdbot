# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

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
COPY node-version.mjs ./
COPY ui/package.json ./ui/package.json
COPY packages ./packages
COPY extensions ./extensions
COPY patches ./patches
COPY scripts/postinstall-bundled-plugins.mjs scripts/preinstall-package-manager-warning.mjs scripts/prepare-git-hooks.mjs scripts/windows-cmd-helpers.mjs ./scripts/
COPY scripts/lib/guard-inventory-utils.mjs ./scripts/lib/guard-inventory-utils.mjs
COPY scripts/lib/package-dist-imports.mjs ./scripts/lib/package-dist-imports.mjs
COPY scripts/lib/package-lifecycle-marker.mjs ./scripts/lib/package-lifecycle-marker.mjs
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
  corepack enable \
  && if ! pnpm install --frozen-lockfile >/tmp/openclaw-cleanup-pnpm-install.log 2>&1; then \
    cat /tmp/openclaw-cleanup-pnpm-install.log; \
    exit 1; \
  fi

COPY . .
COPY --chmod=755 scripts/docker/cleanup-smoke/run.sh /usr/local/bin/openclaw-cleanup-smoke

ENTRYPOINT ["/usr/local/bin/openclaw-cleanup-smoke"]
