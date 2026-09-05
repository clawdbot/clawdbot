# syntax=docker/dockerfile:1.7
#
# Shared Docker E2E image.
# `bare` is a clean Node/Git runner for install/update lanes. `functional`
# installs the prepared OpenClaw npm tarball into /app for built-app lanes.

ARG OPENCLAW_NODE_ALPINE_IMAGE="docker.io/library/node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43"

FROM node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS e2e-runner

# openssl provisions short-lived fixture certificates for HTTPS-only provider
# routes. python3 covers package/plugin install paths that execute helper scripts.
# procps provides pgrep for E2E watchdogs that assert no package-manager work is
# still running after Gateway readiness.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssl procps python3 \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable
RUN npm install -g tsx@4.23.12 --no-fund --no-audit

COPY scripts/prepublish-plugin-registry-artifact.mjs /opt/openclaw-e2e/scripts/
COPY --chmod=0755 scripts/e2e/lib/prepublish-plugin-registry.sh /opt/openclaw-e2e/scripts/e2e/lib/
COPY scripts/e2e/lib/plugins/npm-registry-server.mjs /opt/openclaw-e2e/scripts/e2e/lib/plugins/
COPY scripts/lib/bounded-response.mjs /opt/openclaw-e2e/scripts/lib/

RUN useradd --create-home --shell /bin/bash appuser \
 && mkdir -p /app \
 && chown appuser:appuser /app

ENV HOME="/home/appuser"
ENV PATH="/home/appuser/.local/bin:${PATH}"
ENV NODE_OPTIONS="--disable-warning=ExperimentalWarning"
# Docker E2E lanes start many loopback gateways concurrently; mDNS advertising
# is unrelated to those checks and can flap under container CPU/network load.
ENV OPENCLAW_DISABLE_BONJOUR="1"

USER appuser
WORKDIR /app

FROM e2e-runner AS bare

CMD ["bash"]

FROM bare AS build

CMD ["bash"]

FROM ${OPENCLAW_NODE_ALPINE_IMAGE} AS musl

COPY scripts/docker/verify-fs-safe-native.mjs /tmp/verify-fs-safe-native.mjs

CMD ["sh"]

FROM bare AS functional-manifest

# Per-PR tarballs differ only in built app bytes. Extract the dependency
# manifest alone so the expensive install layer below is keyed on it and stays
# a warm-cache hit until dependencies actually change.
COPY --from=openclaw_package --chown=appuser:appuser openclaw-current.tgz /tmp/openclaw-current.tgz
# Bundled dependencies ship inside the tarball, and the packaged lifecycle
# scripts reference files outside this manifest-only tree. Drop both plus dev
# dependencies so the install below reifies registry dependencies only.
RUN <<'PREPARE_MANIFEST'
set -eu
mkdir -p /tmp/openclaw-deps
tar -xzf /tmp/openclaw-current.tgz -C /tmp/openclaw-deps --strip-components=1 \
  package/package.json
node - <<'NODE'
const fs = require("node:fs");
const manifestPath = "/tmp/openclaw-deps/package.json";
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const name of manifest.bundleDependencies ?? []) {
  delete manifest.dependencies?.[name];
}
delete manifest.bundleDependencies;
delete manifest.devDependencies;
delete manifest.scripts;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
PREPARE_MANIFEST

FROM bare AS functional-deps

# Registry dependencies share the npm cache; prepared core tarballs participate
# in the layer key so candidate code cannot reuse a different core build.
COPY --from=functional-manifest --chown=appuser:appuser /tmp/openclaw-deps /tmp/openclaw-deps
COPY --from=openclaw_package --chown=appuser:appuser registry-identity.json /tmp/registry-identity.json
# Drop npm's hidden tree manifest so the copied node_modules matches a plain
# package install.
# The pinned Node image owns uid 1000, so useradd assigns appuser uid/gid 1001.
RUN --mount=type=cache,target=/home/appuser/.npm,uid=1001,gid=1001,sharing=locked \
    --mount=type=bind,from=openclaw_package,source=prepublish-plugin-registry,target=/tmp/openclaw-prepublish-plugin-registry \
    bash <<'INSTALL_DEPS'
set -euo pipefail
if [ -f /tmp/openclaw-prepublish-plugin-registry/prepublish-plugin-registry.json ]; then
  read -r source_sha candidate_version manifest_sha256 < <(
    node -e 'const value=require("/tmp/registry-identity.json"); console.log(value.sourceSha, value.candidateVersion, value.manifestSha256)'
  )
  export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR=/tmp/openclaw-prepublish-plugin-registry
  export OPENCLAW_DOCKER_E2E_SELECTED_SHA="$source_sha"
  export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION="$candidate_version"
  export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256="$manifest_sha256"
fi
cd /tmp/openclaw-deps
bash /opt/openclaw-e2e/scripts/e2e/lib/prepublish-plugin-registry.sh \
  npm install --omit=dev --no-fund --no-audit
rm -f node_modules/.package-lock.json
INSTALL_DEPS

FROM bare AS functional

# The app under test enters through the named BuildKit context, not by copying
# checkout sources into the image.
COPY --from=openclaw_package --chown=appuser:appuser openclaw-current.tgz /tmp/openclaw-current.tgz
COPY --from=functional-deps --chown=appuser:appuser /tmp/openclaw-deps/node_modules /app/node_modules
COPY --chown=appuser:appuser scripts/docker/verify-fs-safe-native.mjs /tmp/verify-fs-safe-native.mjs
# Extract the package over the prebuilt dependency tree (bundled deps ship in
# the tarball), then run its packaged postinstall. Functional E2E lanes exercise
# private bundled plugins too, so skip the production migration's intentionally
# curated persisted registry in this test image. The /app/node_modules/openclaw
# self-link preserves package self-reference imports such as
# openclaw/plugin-sdk/*; create it after postinstall so its prune walks cannot
# cycle through the link.
RUN tar -xzf /tmp/openclaw-current.tgz -C /app --strip-components=1 \
 && chmod +x /app/openclaw.mjs \
 && node --input-type=module -e "import { runBundledPluginPostinstall } from '/app/scripts/postinstall-bundled-plugins.mjs'; runBundledPluginPostinstall();" \
 && ln -sfn /app /app/node_modules/openclaw \
 && mkdir -p "$HOME/.local/bin" \
 && ln -sf /app/openclaw.mjs "$HOME/.local/bin/openclaw" \
 && node /tmp/verify-fs-safe-native.mjs --package-root /app --mode require \
 && rm -f /tmp/openclaw-current.tgz

CMD ["bash"]
