# syntax=docker/dockerfile:1.7

FROM node:24-bookworm@sha256:3a09aa6354567619221ef6c45a5051b671f953f0a1924d1f819ffb236e520e6b AS e2e-runner

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

RUN useradd --create-home --shell /bin/bash appuser \
 && mkdir -p /app \
 && chown appuser:appuser /app

ENV HOME="/home/appuser"
ENV NODE_OPTIONS="--disable-warning=ExperimentalWarning"
# Docker E2E lanes start many loopback gateways concurrently; mDNS advertising
# is unrelated to those checks and can flap under container CPU/network load.
ENV OPENCLAW_DISABLE_BONJOUR="1"

USER appuser
WORKDIR /app

FROM e2e-runner AS deps

COPY --chown=appuser:appuser package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY --chown=appuser:appuser ui/package.json ./ui/package.json
COPY --chown=appuser:appuser patches ./patches
COPY --chown=appuser:appuser scripts/postinstall-bundled-plugins.mjs scripts/preinstall-package-manager-warning.mjs scripts/npm-runner.mjs scripts/windows-cmd-helpers.mjs ./scripts/
RUN --mount=type=bind,source=extensions,target=/tmp/extensions,readonly \
    find /tmp/extensions -mindepth 2 -maxdepth 2 -name package.json -print | \
    while IFS= read -r manifest; do \
      dest="${manifest#/tmp/}"; \
      mkdir -p "$(dirname "$dest")"; \
      cp "$manifest" "$dest"; \
    done

RUN --mount=type=cache,id=openclaw-pnpm-store,target=/home/appuser/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile

FROM deps AS build

COPY --chown=appuser:appuser tsconfig.json tsconfig.plugin-sdk.dts.json tsdown.config.ts vitest.config.ts openclaw.mjs ./
COPY --chown=appuser:appuser src ./src
COPY --chown=appuser:appuser test ./test
COPY --chown=appuser:appuser scripts ./scripts
COPY --chown=appuser:appuser docs ./docs
COPY --chown=appuser:appuser packages ./packages
COPY --chown=appuser:appuser skills ./skills
COPY --chown=appuser:appuser ui ./ui
COPY --link --chown=appuser:appuser extensions ./extensions
COPY --chown=appuser:appuser vendor/a2ui/renderers/lit ./vendor/a2ui/renderers/lit
COPY --chown=appuser:appuser apps/shared/OpenClawKit/Sources/OpenClawKit/Resources ./apps/shared/OpenClawKit/Sources/OpenClawKit/Resources
COPY --chown=appuser:appuser apps/shared/OpenClawKit/Tools/CanvasA2UI ./apps/shared/OpenClawKit/Tools/CanvasA2UI

RUN pnpm build
# Onboard Docker E2E does not exercise the Control UI itself; it only needs the
# asset-existence check to pass so configure/onboard can continue.
RUN mkdir -p dist/control-ui \
  && printf '%s\n' '<!doctype html><title>OpenClaw Control UI</title>' > dist/control-ui/index.html

CMD ["bash"]
