#!/usr/bin/env bash
# Exercises package-to-git and git-to-package update channel switching in Docker.
# Both package and git fixtures are derived from the same prepared npm tarball.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-update-channel-switch-e2e" OPENCLAW_UPDATE_CHANNEL_SWITCH_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_UPDATE_CHANNEL_SWITCH_E2E_SKIP_BUILD:-0}"
PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz update-channel-switch "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
# Bare lanes mount the package artifact instead of baking app sources into the image.
docker_e2e_package_mount_args "$PACKAGE_TGZ"

docker_e2e_build_or_reuse "$IMAGE_NAME" update-channel-switch "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"

echo "Running update channel switch E2E..."
docker run --rm \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_SKIP_PROVIDERS=1 \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  "$IMAGE_NAME" \
  bash -lc 'set -euo pipefail

export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false
export npm_config_prefix=/tmp/npm-prefix
export NPM_CONFIG_PREFIX=/tmp/npm-prefix
export PNPM_HOME=/tmp/pnpm-home
export PATH="/tmp/npm-prefix/bin:/tmp/pnpm-home:$PATH"
export CI=true
export OPENCLAW_DISABLE_BUNDLED_PLUGINS=1
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_NO_PROMPT=1

package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
git_root="/tmp/openclaw-git"
mkdir -p "$git_root"
# Build the fake git install from the packed package contents, not the checkout.
tar -xzf "$package_tgz" -C "$git_root" --strip-components=1
# The package-derived fixture can carry patchedDependencies whose targets are
# absent from the trimmed tarball install; that should not block update preflight.
node - <<'"'"'NODE'"'"'
const fs = require("node:fs");
const path = require("node:path");
const packageJsonPath = "/tmp/openclaw-git/package.json";
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const isLegacyPackageAcceptanceCompat = (version) => {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[-+].*)?$/.exec(version || "");
  if (!match) return false;
  const value = [Number(match[1]), Number(match[2]), Number(match[3])];
  const max = [2026, 4, 25];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] < max[i]) return true;
    if (value[i] > max[i]) return false;
  }
  return true;
};
const fixtureUiBuildSource = `const fs=require("node:fs");fs.mkdirSync("dist/control-ui",{recursive:true});fs.writeFileSync("dist/control-ui/index.html","<!doctype html><title>fixture</title>\\n")`;
const fixtureUiBuildCommand = `node -e ${JSON.stringify(fixtureUiBuildSource)}`;
const nextPnpm = { ...packageJson.pnpm, allowUnusedPatches: true };
const patchedDependencies = nextPnpm.patchedDependencies;
if (
  patchedDependencies &&
  typeof patchedDependencies === "object" &&
  !Array.isArray(patchedDependencies)
) {
  const patchEntries = Object.entries(patchedDependencies);
  const keptPatches = Object.fromEntries(
    patchEntries.filter(([, patchFile]) => {
      return (
        typeof patchFile === "string" &&
        fs.existsSync(path.resolve(path.dirname(packageJsonPath), patchFile))
      );
    }),
  );
  const missingPatches = patchEntries.filter(([dependency, patchFile]) => {
    return (
      typeof patchFile !== "string" ||
      !fs.existsSync(path.resolve(path.dirname(packageJsonPath), patchFile))
    );
  });
  if (missingPatches.length > 0 && !isLegacyPackageAcceptanceCompat(packageJson.version)) {
    throw new Error(
      `package ${packageJson.version} has missing pnpm.patchedDependencies in package fixture: ${missingPatches
        .map(([dependency, patchFile]) => `${dependency} -> ${patchFile}`)
        .join(", ")}`,
    );
  }
  if (Object.keys(keptPatches).length > 0) {
    nextPnpm.patchedDependencies = keptPatches;
  } else {
    delete nextPnpm.patchedDependencies;
  }
}
packageJson.pnpm = nextPnpm;
packageJson.scripts = {
  ...packageJson.scripts,
  build: "node -e \"console.log(\\\"fixture build skipped\\\")\"",
  lint: "node -e \"console.log(\\\"fixture lint skipped\\\")\"",
  "ui:build": fixtureUiBuildCommand,
};
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
fs.mkdirSync("/tmp/openclaw-git/dist/control-ui", { recursive: true });
fs.writeFileSync("/tmp/openclaw-git/dist/control-ui/index.html", "<!doctype html><title>fixture</title>\n");
NODE
(
  cd "$git_root"
  npm install --omit=optional --no-fund --no-audit >/tmp/openclaw-git-install.log 2>&1
)
node - <<'"'"'NODE'"'"'
const fs = require("node:fs");
fs.mkdirSync("/tmp/openclaw-git/dist/control-ui", { recursive: true });
fs.writeFileSync("/tmp/openclaw-git/dist/control-ui/index.html", "<!doctype html><title>fixture</title>\n");
NODE

git config --global user.email "docker-e2e@openclaw.local"
git config --global user.name "OpenClaw Docker E2E"
git config --global gc.auto 0
git -C "$git_root" init -q
git -C "$git_root" config gc.auto 0
git -C "$git_root" add -A
git -C "$git_root" add -f dist/control-ui/index.html
git -C "$git_root" commit -qm "test fixture"
fixture_sha="$(git -C "$git_root" rev-parse HEAD)"

pkg_tgz_path="$package_tgz"

npm install -g --prefix /tmp/npm-prefix --omit=optional "$pkg_tgz_path"
package_version="$(node -p "JSON.parse(require(\"node:fs\").readFileSync(\"/tmp/npm-prefix/lib/node_modules/openclaw/package.json\", \"utf8\")).version")"
OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT="$(
  node - "$package_version" <<"NODE"
const version = process.argv[2] || "";
const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[-+].*)?$/.exec(version);
if (!match) {
  console.log("0");
  process.exit(0);
}
const value = [Number(match[1]), Number(match[2]), Number(match[3])];
const max = [2026, 4, 25];
for (let i = 0; i < value.length; i += 1) {
  if (value[i] < max[i]) {
    console.log("1");
    process.exit(0);
  }
  if (value[i] > max[i]) {
    console.log("0");
    process.exit(0);
  }
}
console.log("1");
NODE
)"
export OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT

home_dir="$(mktemp -d /tmp/openclaw-update-channel-switch-home.XXXXXX)"
export HOME="$home_dir"
mkdir -p "$HOME/.openclaw"
cat > "$HOME/.openclaw/openclaw.json" <<'"'"'JSON'"'"'
{
  "update": {
    "channel": "stable"
  },
  "plugins": {}
}
JSON

export OPENCLAW_GIT_DIR="$git_root"
export OPENCLAW_UPDATE_DEV_TARGET_REF="$fixture_sha"

echo "==> package -> git dev channel"
set +e
dev_json="$(openclaw update --channel dev --yes --json --no-restart)"
dev_status=$?
set -e
printf "%s\n" "$dev_json"
if [ "$dev_status" -ne 0 ]; then
  exit "$dev_status"
fi
DEV_JSON="$dev_json" node - <<'"'"'NODE'"'"'
const payload = JSON.parse(process.env.DEV_JSON);
if (payload.status !== "ok") {
  throw new Error(`expected dev update status ok, got ${payload.status}`);
}
if (payload.mode !== "git") {
  throw new Error(`expected dev update mode git, got ${payload.mode}`);
}
if (payload.postUpdate?.plugins && payload.postUpdate.plugins.status !== "ok") {
  throw new Error(`expected plugin post-update ok, got ${JSON.stringify(payload.postUpdate?.plugins)}`);
}
NODE

node - <<'"'"'NODE'"'"'
const fs = require("node:fs");
const path = require("node:path");
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (config.update?.channel !== "dev") {
  if (process.env.OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT === "1") {
    console.log(`legacy package did not persist update.channel dev; got ${JSON.stringify(config.update?.channel)}`);
  } else {
    throw new Error(`expected persisted update.channel dev, got ${JSON.stringify(config.update?.channel)}`);
  }
}
NODE

status_json="$(openclaw update status --json)"
printf "%s\n" "$status_json"
STATUS_JSON="$status_json" node - <<'"'"'NODE'"'"'
const payload = JSON.parse(process.env.STATUS_JSON);
if (payload.update?.installKind !== "git") {
  throw new Error(`expected git install after dev switch, got ${payload.update?.installKind}`);
}
NODE

echo "==> git -> package stable channel"
set +e
stable_json="$(openclaw update --channel stable --tag "$pkg_tgz_path" --yes --json --no-restart)"
stable_status=$?
set -e
printf "%s\n" "$stable_json"
if [ "$stable_status" -ne 0 ]; then
  exit "$stable_status"
fi
STABLE_JSON="$stable_json" node - <<'"'"'NODE'"'"'
const payload = JSON.parse(process.env.STABLE_JSON);
if (payload.status !== "ok") {
  throw new Error(`expected stable update status ok, got ${payload.status}`);
}
if (!["npm", "pnpm", "bun"].includes(payload.mode)) {
  throw new Error(`expected package-manager mode after stable switch, got ${payload.mode}`);
}
if (payload.postUpdate?.plugins && payload.postUpdate.plugins.status !== "ok") {
  throw new Error(`expected plugin post-update ok, got ${JSON.stringify(payload.postUpdate?.plugins)}`);
}
NODE

node - <<'"'"'NODE'"'"'
const fs = require("node:fs");
const path = require("node:path");
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (config.update?.channel !== "stable") {
  if (process.env.OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT === "1") {
    console.log(`legacy package did not persist update.channel stable; got ${JSON.stringify(config.update?.channel)}`);
  } else {
    throw new Error(`expected persisted update.channel stable, got ${JSON.stringify(config.update?.channel)}`);
  }
}
NODE

status_json="$(openclaw update status --json)"
printf "%s\n" "$status_json"
STATUS_JSON="$status_json" node - <<'"'"'NODE'"'"'
const payload = JSON.parse(process.env.STATUS_JSON);
if (payload.update?.installKind !== "package") {
  throw new Error(`expected package install after stable switch, got ${payload.update?.installKind}`);
}
NODE

echo "OK"
'
