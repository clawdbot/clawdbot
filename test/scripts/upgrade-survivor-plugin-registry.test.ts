import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/e2e/upgrade-survivor-docker.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SOURCE_SHA = "a".repeat(40);
const VERSION = "2026.8.1";

function registryManifest(): string {
  return `${JSON.stringify({
    candidateVersion: VERSION,
    packages: [],
    schema: "openclaw.prepublish-plugin-registry/v1",
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
  })}\n`;
}

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
  "\${OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS:-}" \
  "$OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS" >>"$CAPTURE_DIR/node-env"
mkdir -p "$OPENCLAW_DOCKER_ALL_LOG_DIR/prepublish-plugin-registry"
printf '%s' "$REGISTRY_MANIFEST" \
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
      OPENCLAW_DOCKER_E2E_SELECTED_SHA: SOURCE_SHA,
      REAL_NODE: process.execPath,
      REGISTRY_MANIFEST: registryManifest(),
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
  it("prepares and mounts the direct auto-auth planner registry", () => {
    const { captureDir, result } = runSurvivor({
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: undefined,
      OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "0",
      OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(captureDir, "node-env"), "utf8")).toBe("update-restart-auth||base\n");
  });

  it("preserves an explicitly supplied direct registry", () => {
    const registryDir = tempDirs.make("openclaw-direct-plugin-registry-");
    const manifestPath = join(registryDir, "prepublish-plugin-registry.json");
    writeFileSync(manifestPath, registryManifest());

    const { captureDir, result } = runSurvivor({
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registryDir,
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: createHash("sha256")
        .update(readFileSync(manifestPath))
        .digest("hex"),
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: undefined,
      OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "0",
      OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(captureDir, "node-args"))).toBe(false);
  });

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
    const manifestPath = join(registryDir, "prepublish-plugin-registry.json");
    writeFileSync(manifestPath, registryManifest());

    const { captureDir, result } = runSurvivor({
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registryDir,
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: createHash("sha256")
        .update(readFileSync(manifestPath))
        .digest("hex"),
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

describe("standalone upgrade survivor live OpenAI probe", () => {
  it("fails closed before Docker when the opted-in key is missing", () => {
    const { captureDir, result } = runSurvivor({
      OPENAI_API_KEY: undefined,
      OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI: "1",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI=1 requires OPENAI_API_KEY",
    );
    expect(existsSync(join(captureDir, "docker-args"))).toBe(false);
  });

  it("forwards the opted-in key by environment name without putting it in Docker arguments", () => {
    const key = "live-openai-key-must-not-appear-in-arguments";
    const { captureDir, result } = runSurvivor({
      OPENAI_API_KEY: key,
      OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI: "1",
      OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI_MODEL: "openai/test-model",
    });

    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(join(captureDir, "docker-args"), "utf8");
    expect(args).toContain("-e OPENAI_API_KEY");
    expect(args).toContain("-e OPENCLAW_UPGRADE_SURVIVOR_LIVE_OPENAI_MODEL=openai/test-model");
    expect(args).not.toContain(key);
  });
});
