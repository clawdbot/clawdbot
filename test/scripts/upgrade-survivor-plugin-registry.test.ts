import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/e2e/upgrade-survivor-docker.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function runSurvivor(overrides: NodeJS.ProcessEnv = {}) {
  const root = tempDirs.make("openclaw-upgrade-survivor-registry-");
  const binDir = join(root, "bin");
  const captureDir = join(root, "capture");
  const packageTarball = join(root, "openclaw-current.tgz");
  mkdirSync(binDir);
  mkdirSync(captureDir);
  writeFileSync(packageTarball, "candidate");
  writeExecutable(
    join(binDir, "node"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" != */scripts/test-docker-all.mjs ]] || [ "\${2:-}" != "--prepare-plugin-registry" ]; then
  exec "$REAL_NODE" "$@"
fi
printf '%s\n' "$*" >>"$CAPTURE_DIR/node-args"
printf '%s|%s|%s\n' \
  "$OPENCLAW_DOCKER_ALL_LANES" \
  "$OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS" \
  "$OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS" >>"$CAPTURE_DIR/node-env"
mkdir -p "$OPENCLAW_DOCKER_ALL_LOG_DIR/prepublish-plugin-registry"
printf '{"packages":[]}\n' \
  >"$OPENCLAW_DOCKER_ALL_LOG_DIR/prepublish-plugin-registry/prepublish-plugin-registry.json"
printf '{"dir":"%s"}\n' "$OPENCLAW_DOCKER_ALL_LOG_DIR/prepublish-plugin-registry"
`,
  );
  writeExecutable(
    join(binDir, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CAPTURE_DIR/docker-args"
previous=""
for arg in "$@"; do
  if [ "$previous" = "--cidfile" ]; then
    printf 'fake-container\n' >"$arg"
  fi
  previous="$arg"
done
`,
  );

  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      CAPTURE_DIR: captureDir,
      REAL_NODE: process.execPath,
      OPENCLAW_CURRENT_PACKAGE_TGZ: packageTarball,
      OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_DIR: join(root, "artifacts"),
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "openclaw@2026.7.1-2",
      OPENCLAW_UPGRADE_SURVIVOR_E2E_SKIP_BUILD: "1",
      OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "1",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      TMPDIR: root,
      ...overrides,
    },
    timeout: 30_000,
  });
  return { captureDir, packageTarball, result, root };
}

describe("standalone upgrade survivor plugin registry", () => {
  it("prepares and mounts a planner-owned registry for the current candidate", () => {
    const { captureDir, result } = runSurvivor({
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "configured-plugin-installs",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(captureDir, "node-args"), "utf8")).toContain(
      "scripts/test-docker-all.mjs --prepare-plugin-registry",
    );
    expect(readFileSync(join(captureDir, "node-env"), "utf8")).toBe(
      "published-upgrade-survivor|openclaw@2026.7.1-2|configured-plugin-installs\n",
    );
    expect(readFileSync(join(captureDir, "docker-args"), "utf8")).toContain(
      ":/tmp/openclaw-prepublish-plugin-registry:ro",
    );
  });

  it("preserves an explicitly supplied registry without preparing another", () => {
    const registryDir = tempDirs.make("openclaw-external-plugin-registry-");
    writeFileSync(join(registryDir, "prepublish-plugin-registry.json"), '{"external":true}\n');

    const { captureDir, result } = runSurvivor({
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registryDir,
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "external-only-scenario",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(captureDir, "node-args"))).toBe(false);
    expect(readFileSync(join(captureDir, "docker-args"), "utf8")).toContain(
      `${registryDir}:/tmp/openclaw-prepublish-plugin-registry:ro`,
    );
  });

  it("does not prepare a registry for a published candidate", () => {
    const { captureDir, packageTarball, result } = runSurvivor({
      OPENCLAW_CURRENT_PACKAGE_TGZ: undefined,
      OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE: "openclaw@2026.8.1",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "published-only-scenario",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(captureDir, "node-args"))).toBe(false);
    expect(readFileSync(join(captureDir, "docker-args"), "utf8")).not.toContain(
      "/tmp/openclaw-prepublish-plugin-registry",
    );
    expect(existsSync(packageTarball)).toBe(true);
  });
});
