# syntax=docker/dockerfile:1.7
#
# Shared Docker E2E image.
# `bare` is a clean Node/Git runner for install/update lanes. `functional`
# installs the prepared OpenClaw npm tarball into /app for built-app lanes.

FROM node:24-bookworm-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf AS e2e-runner

# openssl provisions short-lived fixture certificates for HTTPS-only provider
# routes. python3 covers package/plugin install paths that execute helper scripts.
# procps provides pgrep for E2E watchdogs that assert no package-manager work is
# still running after Gateway readiness.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssl procps python3 \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable
RUN npm install -g tsx@4.21.0 --no-fund --no-audit

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

FROM bare AS functional-manifest

# Per-PR tarballs differ only in built app bytes. Extract the dependency
# manifest alone so the expensive install layer below is keyed on it and stays
# a warm-cache hit until dependencies actually change.
COPY --from=openclaw_package --chown=appuser:appuser openclaw-current.tgz /tmp/openclaw-current.tgz
# Bundled dependencies ship inside the tarball and are absent from the
# shrinkwrap, and the packaged lifecycle scripts reference files outside this
# manifest-only tree; drop both (plus dev deps, which the shrinkwrap omits) so
# the install below reifies registry dependencies only.
RUN <<'PREPARE_MANIFEST'
set -eu
mkdir -p /tmp/openclaw-deps
tar -xzf /tmp/openclaw-current.tgz -C /tmp/openclaw-deps --strip-components=1 \
  package/package.json package/npm-shrinkwrap.json
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

# Cache key: normalized manifest + shrinkwrap contents only (COPY hashes file
# content, not the tarball), so unchanged dependencies skip the full reify.
COPY --from=functional-manifest --chown=appuser:appuser /tmp/openclaw-deps /tmp/openclaw-deps
# `npm install` (not `npm ci`) because the generated shrinkwrap is not
# guaranteed to pass `npm ci`'s strict manifest sync check; the shrinkwrap
# still pins every synced edge, and this reify follows it more faithfully than
# `npm install -g <tarball>` does. Drop npm's hidden tree manifest so the
# copied node_modules matches a plain package install.
# The pinned Node image owns uid 1000, so useradd assigns appuser uid/gid 1001.
RUN --mount=type=cache,target=/home/appuser/.npm,uid=1001,gid=1001,sharing=locked \
    cd /tmp/openclaw-deps \
 && npm install --omit=dev --no-fund --no-audit \
 && rm -f node_modules/.package-lock.json

FROM bare AS functional

# The app under test enters through the named BuildKit context, not by copying
# checkout sources into the image.
COPY --from=openclaw_package --chown=appuser:appuser openclaw-current.tgz /tmp/openclaw-current.tgz
COPY --from=functional-deps --chown=appuser:appuser /tmp/openclaw-deps/node_modules /app/node_modules
# Extract the package over the prebuilt dependency tree (bundled deps ship in
# the tarball), then run its packaged postinstall. Functional E2E lanes exercise
# private bundled plugins too, so skip the production migration's intentionally
# curated persisted registry in this test image. The /app/node_modules/openclaw
# self-link preserves package self-reference imports such as
# openclaw/plugin-sdk/*; create it after postinstall so its prune walks cannot
# cycle through the link.
RUN tar -xzf /tmp/openclaw-current.tgz -C /app --strip-components=1 \
 && chmod +x /app/openclaw.mjs \
 && OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION=1 node /app/scripts/postinstall-bundled-plugins.mjs \
 && ln -sfn /app /app/node_modules/openclaw \
 && mkdir -p "$HOME/.local/bin" \
 && ln -sf /app/openclaw.mjs "$HOME/.local/bin/openclaw" \
 && rm -f /tmp/openclaw-current.tgz

CMD ["bash"]
