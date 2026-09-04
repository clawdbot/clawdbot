# Opt-in plugin dependencies and supported runtime builds (space- or comma-separated ids).
# Manifest ids and existing source-directory names are accepted.
# Example: docker build --build-arg OPENCLAW_EXTENSIONS="diagnostics-otel,matrix" .
#
# Multi-stage build produces a minimal runtime image without build tools,
# source code, or Bun. Works with Docker, Buildx, and Podman.
# The dependency manifest stages extract only package.json files, so the main
# build layer is not invalidated by unrelated source changes.
#
# Build stages use full bookworm; the runtime image is always bookworm-slim.
ARG OPENCLAW_EXTENSIONS=""
ARG OPENCLAW_BUNDLED_PLUGIN_DIR=extensions
ARG OPENCLAW_DOCKER_BUILD_NODE_OPTIONS="--max-old-space-size=8192"
ARG OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB=""
ARG OPENCLAW_DOCKER_BUILD_SKIP_DTS=1
ARG OPENCLAW_NODE_BOOKWORM_IMAGE="docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584"
ARG OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE="docker.io/library/node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03"
ARG OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST="sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03"
# Keep in sync with .github/actions/setup-node-env/action.yml bun-version.
# To update: docker buildx imagetools inspect docker.io/oven/bun:<version> and use the manifest-list digest.
ARG OPENCLAW_BUN_IMAGE="docker.io/oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6"

# Base images are pinned to SHA256 digests for reproducible builds.
# Dependabot refreshes these blessed digests; release builds consume the
# reviewed base snapshot instead of mutating distro state on every build.
# To update, run: docker buildx imagetools inspect docker.io/library/node:24-bookworm and
# docker.io/library/node:24-bookworm-slim (or podman) and replace the digests below with the
# current multi-arch manifest list entries.

FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS workspace-deps
ARG OPENCLAW_EXTENSIONS
ARG OPENCLAW_BUNDLED_PLUGIN_DIR
# Copy package.json files for workspace packages used by the install layer.
# Manifest-only bundled plugins remain valid selections but need no workspace metadata.
# Use COPY because build-context bind mounts are unreliable across supported
# Podman/Buildah hosts. Full trees stay in this disposable stage; later stages
# receive only extracted manifests.
COPY scripts/lib/docker-plugin-selection.mjs /tmp/docker-plugin-selection.mjs
COPY scripts/lib/root-package-bundled-plugin-excludes.mjs /tmp/root-package-bundled-plugin-excludes.mjs
COPY package.json /tmp/package.json
COPY packages /tmp/packages
COPY ${OPENCLAW_BUNDLED_PLUGIN_DIR} /tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}
RUN mkdir -p /out/packages "/out/${OPENCLAW_BUNDLED_PLUGIN_DIR}" && \
    for manifest in /tmp/packages/*/package.json; do \
      [ -f "$manifest" ] || continue; \
      pkg_dir="${manifest%/package.json}"; \
      pkg_name="${pkg_dir##*/}"; \
      mkdir -p "/out/packages/$pkg_name" && \
      cp "$manifest" "/out/packages/$pkg_name/package.json"; \
    done && \
    node /tmp/docker-plugin-selection.mjs "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}" "$OPENCLAW_EXTENSIONS" \
      > /out/openclaw-selected-plugin-dirs && \
    node /tmp/docker-plugin-selection.mjs "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}" "$OPENCLAW_EXTENSIONS" \
      --required-platform-packages > /out/openclaw-required-platform-packages && \
    node /tmp/docker-plugin-selection.mjs "/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}" "$OPENCLAW_EXTENSIONS" \
      --required-bundled /tmp/package.json > /tmp/openclaw-workspace-plugin-dirs && \
    while IFS= read -r ext; do \
      ext_dir="/tmp/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext"; \
      if [ -f "$ext_dir/package.json" ]; then \
        mkdir -p "/out/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext" && \
        cp "$ext_dir/package.json" "/out/${OPENCLAW_BUNDLED_PLUGIN_DIR}/$ext/package.json"; \
      fi; \
    done < /tmp/openclaw-workspace-plugin-dirs

# Shared manifest-only inputs. Both installs start without node_modules so pnpm
# never has to rename a dependency directory inherited from an OverlayFS layer.
FROM ${OPENCLAW_NODE_BOOKWORM_IMAGE} AS dependency-inputs
ARG OPENCLAW_BUNDLED_PLUGIN_DIR

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY node-version.mjs ./
COPY openclaw.mjs ./
COPY ui/package.json ./ui/package.json
COPY patches ./patches
COPY scripts/postinstall-bundled-plugins.mjs scripts/preinstall-package-manager-warning.mjs scripts/windows-cmd-helpers.mjs scripts/prepare-git-hooks.mjs ./scripts/
COPY scripts/lib/guard-inventory-utils.mjs ./scripts/lib/guard-inventory-utils.mjs
COPY scripts/lib/package-dist-imports.mjs ./scripts/lib/package-dist-imports.mjs
COPY scripts/lib/package-lifecycle-marker.mjs ./scripts/lib/package-lifecycle-marker.mjs
COPY scripts/docker/verify-fs-safe-native.mjs ./scripts/docker/verify-fs-safe-native.mjs
COPY scripts/docker/verify-native-addons.sh ./scripts/docker/verify-native-addons.sh

COPY --from=workspace-deps /out/packages/ ./packages/
COPY --from=workspace-deps /out/${OPENCLAW_BUNDLED_PLUGIN_DIR}/ ./${OPENCLAW_BUNDLED_PLUGIN_DIR}/
COPY --from=workspace-deps /out/openclaw-selected-plugin-dirs /tmp/openclaw-selected-plugin-dirs
COPY --from=workspace-deps /out/openclaw-required-platform-packages /tmp/openclaw-required-platform-packages

# ── Production dependencies ────────────────────────────────────
FROM dependency-inputs AS production-deps
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile --prod \
      --config.supportedArchitectures.os=linux \
      --config.supportedArchitectures.cpu="$(node -p 'process.arch')" \
      --config.supportedArchitectures.libc=glibc
RUN sh scripts/docker/verify-native-addons.sh

# ── Build ──────────────────────────────────────────────────────
FROM ${OPENCLAW_BUN_IMAGE} AS bun-binary
FROM dependency-inputs AS build
ARG OPENCLAW_DOCKER_BUILD_NODE_OPTIONS
ARG OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB
ARG OPENCLAW_DOCKER_BUILD_SKIP_DTS

# Copy pinned Bun binary from the official image instead of fetching via curl.
COPY --from=bun-binary /usr/local/bin/bun /usr/local/bin/bun

# Reduce OOM risk on low-memory hosts during dependency installation.
# Docker builds on small VMs may otherwise fail with "Killed" (exit 137).
RUN --mount=type=cache,id=openclaw-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    NODE_OPTIONS=--max-old-space-size=2048 pnpm install --frozen-lockfile \
      --config.supportedArchitectures.os=linux \
      --config.supportedArchitectures.cpu="$(node -p 'process.arch')" \
      --config.supportedArchitectures.libc=glibc

RUN sh scripts/docker/verify-native-addons.sh

# Public source provenance supplied by release automation or local setup. Keep
# these after the dependency layer so a new timestamp does not invalidate install.
ARG GIT_COMMIT=""
ARG OPENCLAW_BUILD_TIMESTAMP=""
ARG OPENCLAW_DOCKER_BUILD_VERSION=""
ENV GIT_COMMIT=${GIT_COMMIT} \
    OPENCLAW_BUILD_TIMESTAMP=${OPENCLAW_BUILD_TIMESTAMP}

COPY . .

# The build stage also backs non-root live-test containers. Build contexts preserve
# host modes, so normalize copied source readability without re-walking installed deps.
RUN find /app -path /app/node_modules -prune -o -exec chmod a+rX {} +

# Normalize extension paths now so runtime COPY preserves safe modes
# without adding a second full extensions layer.
RUN for dir in /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} /app/.agent /app/.agents; do \
      if [ -d "$dir" ]; then \
        find "$dir" -type d -exec chmod 755 {} +; \
        find "$dir" -type f -exec chmod 644 {} +; \
      fi; \
    done

# A2UI bundle may fail under QEMU cross-compilation (e.g. building amd64
# on Apple Silicon). CI builds natively per-arch so this is a no-op there.
# Stub it so local cross-arch builds still succeed.
RUN pnpm_config_verify_deps_before_run=false pnpm canvas:a2ui:bundle || \
    (echo "A2UI bundle: creating stub (non-fatal)" && \
     mkdir -p extensions/canvas/src/host/a2ui && \
     echo "/* A2UI bundle unavailable in this build */" > extensions/canvas/src/host/a2ui/a2ui.bundle.js && \
     echo "stub" > extensions/canvas/src/host/a2ui/.bundle.hash && \
     rm -rf vendor/a2ui apps/shared/OpenClawKit/Tools/CanvasA2UI)
# Force pnpm for UI build (Bun may fail on ARM/Synology architectures)
ENV OPENCLAW_PREFER_PNPM=1
# Correction-release sources keep the base package version; official images
# stamp the complete release version before generating their build metadata.
RUN set -eu; \
    selected_plugin_dirs="$(cat /tmp/openclaw-selected-plugin-dirs)"; \
    if [ -n "$OPENCLAW_DOCKER_BUILD_VERSION" ]; then \
      pnpm pkg set "version=$OPENCLAW_DOCKER_BUILD_VERSION"; \
    fi; \
    if [ -z "$OPENCLAW_BUILD_TIMESTAMP" ]; then \
      OPENCLAW_BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; \
      export OPENCLAW_BUILD_TIMESTAMP; \
    fi; \
    if grep -qx 'qa-lab' /tmp/openclaw-selected-plugin-dirs; then \
      export OPENCLAW_BUILD_PRIVATE_QA=1 OPENCLAW_ENABLE_PRIVATE_QA_CLI=1; \
    fi; \
    OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS="$selected_plugin_dirs" OPENCLAW_RUN_NODE_SKIP_DTS_BUILD="$OPENCLAW_DOCKER_BUILD_SKIP_DTS" OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB="$OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB" NODE_OPTIONS="$OPENCLAW_DOCKER_BUILD_NODE_OPTIONS" pnpm_config_verify_deps_before_run=false pnpm build:docker; \
    pnpm_config_verify_deps_before_run=false pnpm ui:build
RUN if grep -qx 'qa-lab' /tmp/openclaw-selected-plugin-dirs; then \
      pnpm_config_verify_deps_before_run=false pnpm qa:lab:build && \
      mkdir -p dist/extensions/qa-lab/web && \
      rm -rf dist/extensions/qa-lab/web/dist && \
      cp -R extensions/qa-lab/web/dist dist/extensions/qa-lab/web/dist; \
    fi

# Keep compiled workspaces and generated plugin assets, but omit development
# dependency trees before merging the build output into the production install.
FROM build AS runtime-build-output
ARG OPENCLAW_BUNDLED_PLUGIN_DIR
RUN rm -rf node_modules ui/node_modules && \
    find packages "${OPENCLAW_BUNDLED_PLUGIN_DIR}" -name node_modules -prune -exec rm -rf {} +

# Inherit production dependencies instead of copying their full tree again.
# The build overlay also carries the stamped release package.json.
FROM production-deps AS runtime-assets
ARG OPENCLAW_BUNDLED_PLUGIN_DIR
COPY --from=runtime-build-output /app/ ./

# Prune omitted plugins and build metadata. Keep SDK-native binaries only for
# selected plugins that explicitly require them.
RUN OPENCLAW_EXTENSIONS="$(cat /tmp/openclaw-selected-plugin-dirs)" OPENCLAW_BUNDLED_PLUGIN_DIR="$OPENCLAW_BUNDLED_PLUGIN_DIR" node scripts/prune-docker-plugin-dist.mjs && \
    node scripts/postinstall-bundled-plugins.mjs && \
    find dist -type f \( -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.map' \) -delete && \
    if [ -L /app/node_modules/@openclaw/ai ]; then \
      ai_runtime_target="$(readlink -f /app/node_modules/@openclaw/ai)" && \
      ai_runtime_tmp="$(mktemp -d)" && \
      cp -a "$ai_runtime_target" "$ai_runtime_tmp/ai" && \
      rm /app/node_modules/@openclaw/ai && \
      mv "$ai_runtime_tmp/ai" /app/node_modules/@openclaw/ai && \
      rmdir "$ai_runtime_tmp"; \
    fi && \
    rm -rf \
      /app/node_modules/openclaw \
      /app/node_modules/.bin/openclaw \
      /app/node_modules/.pnpm/openclaw@*/node_modules/openclaw && \
    if ! grep -q '^@anthropic-ai/claude-agent-sdk-' /tmp/openclaw-required-platform-packages; then \
      find /app/node_modules/@anthropic-ai -maxdepth 1 -type d \
        -name 'claude-agent-sdk-linux-*' -exec rm -rf {} +; \
    fi && \
    node --input-type=module -e 'await import("grammy")' && \
    node scripts/check-package-dist-imports.mjs /app

# ── Runtime base image ──────────────────────────────────────────
FROM ${OPENCLAW_NODE_BOOKWORM_SLIM_IMAGE} AS base-runtime
ARG OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST
LABEL org.opencontainers.image.base.name="docker.io/library/node:24-bookworm-slim" \
  org.opencontainers.image.base.digest="${OPENCLAW_NODE_BOOKWORM_SLIM_DIGEST}"

# ── Stage 3: Runtime ────────────────────────────────────────────
FROM base-runtime
ARG OPENCLAW_BUNDLED_PLUGIN_DIR

# OCI base-image metadata for downstream image consumers.
# If you change these annotations, also update:
# - docs/install/docker.md ("Base image metadata" section)
# - https://docs.openclaw.ai/install/docker
LABEL org.opencontainers.image.source="https://github.com/openclaw/openclaw" \
  org.opencontainers.image.url="https://openclaw.ai" \
  org.opencontainers.image.documentation="https://docs.openclaw.ai/install/docker" \
  org.opencontainers.image.licenses="MIT" \
  org.opencontainers.image.title="OpenClaw" \
  org.opencontainers.image.description="OpenClaw gateway and CLI runtime container image"

WORKDIR /app

# Install missing runtime utilities and the OpenMP library required by llama-server.
# `ca-certificates` ships in `bookworm` (full) but not in `bookworm-slim`,
# so it must be installed explicitly here. Without it `/etc/ssl/certs/`
# stays empty and every HTTPS outbound dies at TLS handshake with
# `error setting certificate file`.
# The runtime image must include the SSH client because the sandbox backend
# spawns `ssh` directly, and bookworm-slim does not provide it.
# Apply current Debian point-release security fixes even when the pinned base
# digest predates them, without waiting for a base-digest refresh.
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git hostname libgomp1 lsof openssh-client openssl procps python3 tini && \
    update-ca-certificates

# Keep npm as an operator-facing capability while replacing the base image's
# bundled CLI dependency tree with the current release. The published package
# omits its dev tools, so hide their metadata during the script-free refresh.
RUN npm install --global npm@latest && \
    npm_dir="$(npm root --global)/npm" && \
    cp "$npm_dir/package.json" /tmp/npm-package.json && \
    node -e 'const fs = require("node:fs"); const file = process.argv[1]; const packageJson = JSON.parse(fs.readFileSync(file, "utf8")); delete packageJson.devDependencies; fs.writeFileSync(file, `${JSON.stringify(packageJson, null, 2)}\n`);' "$npm_dir/package.json" && \
    npm update --prefix "$npm_dir" --omit=dev --ignore-scripts --no-audit --no-fund && \
    mv /tmp/npm-package.json "$npm_dir/package.json" && \
    npm cache clean --force

RUN chown node:node /app

COPY --from=runtime-assets --chown=node:node /app/dist ./dist
COPY --from=runtime-assets --chown=node:node /app/node_modules ./node_modules
COPY --from=runtime-assets --chown=node:node /app/package.json .
COPY --from=runtime-assets --chown=node:node /app/pnpm-workspace.yaml .
COPY --from=runtime-assets --chown=node:node /app/patches ./patches
COPY --from=runtime-assets --chown=node:node /app/node-version.mjs .
COPY --from=runtime-assets --chown=node:node /app/openclaw.mjs .
COPY --from=runtime-assets --chown=node:node /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} ./${OPENCLAW_BUNDLED_PLUGIN_DIR}
COPY --from=runtime-assets --chown=node:node /app/skills ./skills
COPY --from=runtime-assets --chown=node:node /app/docs ./docs
COPY --from=runtime-assets --chown=node:node /app/qa ./qa
RUN --mount=from=dependency-inputs,source=/app/scripts/docker/verify-fs-safe-native.mjs,target=/tmp/verify-fs-safe-native.mjs \
    node /tmp/verify-fs-safe-native.mjs --package-root /app --mode require

# Validate the three version surfaces in every release-built runtime variant.
ARG OPENCLAW_DOCKER_BUILD_VERSION
RUN if [ -n "$OPENCLAW_DOCKER_BUILD_VERSION" ]; then \
      test "$(node -p "require(\"/app/package.json\").version")" = "$OPENCLAW_DOCKER_BUILD_VERSION"; \
      test "$(node -p "require(\"/app/dist/build-info.json\").version")" = "$OPENCLAW_DOCKER_BUILD_VERSION"; \
      test "$(node /app/openclaw.mjs --version | cut -d ' ' -f 2)" = "$OPENCLAW_DOCKER_BUILD_VERSION"; \
    fi

# Keep pnpm available in the runtime image for container-local workflows.
# Use a shared Corepack home so the non-root `node` user does not need a
# first-run network fetch when invoking pnpm. Warm in /app to also record
# its pinned toolchain metadata before offline runtime use.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN install -d -m 0755 "$COREPACK_HOME" && \
    corepack enable && \
    pnpm_spec="$(node -p "require('./package.json').packageManager")" && \
    for attempt in 1 2 3 4 5; do \
      if corepack prepare "$pnpm_spec" --activate; then \
        break; \
      fi; \
      if [ "$attempt" -eq 5 ]; then \
        exit 1; \
      fi; \
      sleep $((attempt * 2)); \
    done && \
    corepack "$pnpm_spec" --version && \
    chmod a+r /app/pnpm-lock.yaml && \
    chmod -R a+rX "$COREPACK_HOME"

# Install additional system packages needed by your skills or extensions.
# Example: docker build --build-arg OPENCLAW_IMAGE_APT_PACKAGES="python3 wget" .
# Legacy alias: OPENCLAW_DOCKER_APT_PACKAGES is still accepted as a fallback.
ARG OPENCLAW_IMAGE_APT_PACKAGES
ARG OPENCLAW_DOCKER_APT_PACKAGES=""
ENV PATH="/home/node/.local/bin:${PATH}"
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    packages="${OPENCLAW_IMAGE_APT_PACKAGES:-$OPENCLAW_DOCKER_APT_PACKAGES}"; \
    if [ -n "$packages" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $packages; \
    fi

# Install additional Python packages needed by your plugins or skills.
# Example: docker build --build-arg OPENCLAW_IMAGE_PIP_PACKAGES="requests humanize" .
ARG OPENCLAW_IMAGE_PIP_PACKAGES=""
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_IMAGE_PIP_PACKAGES" ]; then \
      if ! python3 -m pip --version >/dev/null 2>&1; then \
        apt-get update && \
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-pip; \
      fi && \
      python3 -m pip install --no-cache-dir --break-system-packages $OPENCLAW_IMAGE_PIP_PACKAGES; \
    fi

# Optionally install Chromium and Xvfb for browser automation.
# Build with: docker build --build-arg OPENCLAW_INSTALL_BROWSER=1 ...
# Adds ~300MB but eliminates the 60-90s Playwright install on every container start.
# Must run after node_modules COPY so playwright-core is available.
ARG OPENCLAW_INSTALL_BROWSER=""
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_INSTALL_BROWSER" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb && \
      mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" && \
      node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
      chown -R node:node "$PLAYWRIGHT_BROWSERS_PATH"; \
    fi

# Optionally install Docker CLI for sandbox container management.
# Build with: docker build --build-arg OPENCLAW_INSTALL_DOCKER_CLI=1 ...
# Adds ~50MB. Only the CLI is installed — no Docker daemon.
# Required for agents.defaults.sandbox to function in Docker deployments.
ARG OPENCLAW_INSTALL_DOCKER_CLI=""
ARG OPENCLAW_DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
RUN --mount=type=cache,id=openclaw-bookworm-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=openclaw-bookworm-apt-lists,target=/var/lib/apt,sharing=locked \
    if [ -n "$OPENCLAW_INSTALL_DOCKER_CLI" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg && \
      install -m 0755 -d /etc/apt/keyrings && \
      # Verify Docker apt signing key fingerprint before trusting it as a root key.
      # Require exactly one primary key (`pub` in --with-colons; subkeys use `sub`) so we
      # never pin the first fingerprint while apt trusts extra keys from the same file.
      # Update OPENCLAW_DOCKER_GPG_FINGERPRINT when Docker rotates release keys.
      curl -fsSL --connect-timeout 10 --max-time 120 \
        https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc && \
      expected_fingerprint="$(printf '%s' "$OPENCLAW_DOCKER_GPG_FINGERPRINT" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')" && \
      docker_gpg_pub_count="$(gpg --batch --show-keys --with-colons /tmp/docker.gpg.asc | awk -F: '$1 == "pub" { c++ } END { print c+0 }')" && \
      if [ "$docker_gpg_pub_count" != "1" ]; then \
        echo "ERROR: Docker apt key must contain exactly one public key (found $docker_gpg_pub_count); refusing a multi-key file." >&2; \
        exit 1; \
      fi && \
      actual_fingerprint="$(gpg --batch --show-keys --with-colons /tmp/docker.gpg.asc | awk -F: '$1 == "fpr" { print toupper($10); exit }')" && \
      if [ -z "$actual_fingerprint" ] || [ "$actual_fingerprint" != "$expected_fingerprint" ]; then \
        echo "ERROR: Docker apt key fingerprint mismatch (expected $expected_fingerprint, got ${actual_fingerprint:-<empty>})" >&2; \
        exit 1; \
      fi && \
      gpg --dearmor -o /etc/apt/keyrings/docker.gpg /tmp/docker.gpg.asc && \
      rm -f /tmp/docker.gpg.asc && \
      chmod a+r /etc/apt/keyrings/docker.gpg && \
      printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable\n' \
        "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.list && \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        docker-ce-cli docker-compose-plugin; \
    fi

# Expose the CLI binary without requiring npm global writes as non-root.
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw \
 && chmod 755 /app/openclaw.mjs

# Pre-create default named-volume mount points so first-run Docker volumes copy
# node ownership from the image instead of starting as root-owned directories.
# NOTE: /home/node/.config must be created with node ownership first so that
# the leaf /home/node/.config/openclaw inherits the correct parent permissions.
# Without this, install -d leaves /home/node/.config as root:root (issue #85968).
RUN install -d -m 0755 -o node -g node /home/node/.config && \
    install -d -m 0700 -o node -g node \
      /home/node/.openclaw \
      /home/node/.openclaw/workspace \
      /home/node/.config/openclaw && \
    stat -c '%U:%G %a' /home/node/.openclaw | grep -qx 'node:node 700' && \
    stat -c '%U:%G %a' /home/node/.openclaw/workspace | grep -qx 'node:node 700' && \
    stat -c '%U:%G %a' /home/node/.config | grep -qx 'node:node 755' && \
    stat -c '%U:%G %a' /home/node/.config/openclaw | grep -qx 'node:node 700'

ENV NODE_ENV=production

# Security hardening: Run as non-root user
# The node:24-bookworm image includes a 'node' user (uid 1000)
# This reduces the attack surface by preventing container escape via root privileges
USER node

# Verify the shipped toolchain needs no privileged writes or first-run downloads.
RUN COREPACK_ENABLE_NETWORK=0 PNPM_CONFIG_OFFLINE=true pnpm --version

# Start gateway server with default config.
# Binds to loopback (127.0.0.1) by default for security.
#
# IMPORTANT: With Docker bridge networking (-p 18789:18789), loopback bind
# makes the gateway unreachable from the host. Either:
#   - Use --network host, OR
#   - Override --bind to "lan" (0.0.0.0) and set auth credentials
#
# Built-in probe endpoints for container health checks:
#   - GET /healthz (liveness), GET /startupz (startup/traffic admission),
#     and GET /readyz (channel-aware readiness)
#   - aliases: /health, /startup, and /ready
# For external access from host/ingress, override bind to "lan" and set auth.
HEALTHCHECK --interval=3m --timeout=10s --start-period=15s --retries=3 \
  CMD ["node", "dist/docker-healthcheck.js"]
ENTRYPOINT ["tini", "-s", "--"]
CMD ["node", "openclaw.mjs", "gateway"]
