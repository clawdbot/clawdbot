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

function expectFinalFailure(stderr: string, exitCode: number) {
  const summary = `[upgrade-survivor] FAILED (exit ${exitCode})`;
  expect(stderr.trimEnd().split("\n").at(-1)).toBe(summary);
  expect(stderr.split("\n").filter((line) => line === summary)).toHaveLength(1);
}

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

function runSurvivor(overrides: NodeJS.ProcessEnv = {}, shell = "bash") {
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
printf '%s' "$OPENCLAW_DOCKER_ALL_LOG_DIR" >"$CAPTURE_DIR/preparation-dir"
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
if [ "\${1:-}" = run ]; then
  printf '%s\\0' "$@" >"$CAPTURE_DIR/docker-run-args"
  if [ -n "\${FIXTURE_PAYLOAD_SHELL:-}" ]; then
    exec "$FIXTURE_PAYLOAD_SHELL" -c "\${!#}"
  fi
fi
previous=""
for arg in "$@"; do
  if [ "$previous" = "--cidfile" ]; then
    printf 'fake-container\n' >"$arg"
  fi
  previous="$arg"
done
[ "\${1:-}" != run ] || exit "\${FIXTURE_RUN_EXIT:-0}"
`,
  );

  const result = spawnSync(shell, [SCRIPT], {
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
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: join(root, "artifacts"),
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: join(root, "runtime"),
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
  // macOS /bin/bash is 3.2; PATH may select a newer Bash. Exercise both owners.
  describe.each(process.platform === "darwin" ? ["/bin/bash", "bash"] : ["bash"])(
    "%s wrapper",
    (shell) => {
      it("reaches the direct child invocation with empty optional arguments", () => {
        const { captureDir, result } = runSurvivor(
          {
            OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "0",
            OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
          },
          shell,
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).not.toContain("unbound variable");
        expect(result.stderr).not.toContain("FAILED (exit");
        expect(readFileSync(join(captureDir, "node-env"), "utf8")).toBe(
          "update-restart-auth||base\n",
        );
        const args = readFileSync(join(captureDir, "docker-run-args"), "utf8")
          .split("\0")
          .slice(0, -1);
        expect(args).toContain("run");
        expect(args).toContain("OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE=auto-auth");
        expect(args).not.toContain("--user");
        expect(args).not.toContain("");
        expect(args.at(-2)).toBe("-lc");
      });

      it("rejects a nounset preflight failure even when Bash reports zero to EXIT", () => {
        const prelude = join(tempDirs.make("survivor-preflight-fault-"), "bash-env");
        writeFileSync(
          prelude,
          `trap 'if [[ "$BASH_COMMAND" == docker_e2e_build_or_reuse* ]]; then : "$SURVIVOR_UNSET_PREFLIGHT"; fi' DEBUG\n`,
        );
        const { captureDir, result } = runSurvivor(
          {
            BASH_ENV: prelude,
            SURVIVOR_UNSET_PREFLIGHT: undefined,
            OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "0",
          },
          shell,
        );
        expect(result.stderr).toContain("SURVIVOR_UNSET_PREFLIGHT");
        expect(result.status).toBe(1);
        expectFinalFailure(result.stderr, 1);
        expect(existsSync(join(captureDir, "docker-run-args"))).toBe(false);
        expect(result.stdout).not.toContain("Docker E2E passed");
      });

      it("preserves child failure through cleanup", () => {
        const { captureDir, result } = runSurvivor(
          {
            OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "0",
            FIXTURE_RUN_EXIT: "42",
          },
          shell,
        );
        expect(existsSync(join(captureDir, "docker-run-args"))).toBe(true);
        expect(result.status, result.stderr).toBe(42);
        expectFinalFailure(result.stderr, 42);
        expect(result.stdout).not.toContain("Docker E2E passed");
        expect(existsSync(readFileSync(join(captureDir, "preparation-dir"), "utf8"))).toBe(false);
      });

      it("rejects an early zero exit from the actual scenario before any application work", () => {
        const prelude = join(tempDirs.make("survivor-scenario-fault-"), "bash-env");
        writeFileSync(
          prelude,
          `trap 'if [[ "$BASH_COMMAND" == openclaw_e2e_eval_test_state_from_b64* ]]; then exit 0; fi' DEBUG\n`,
        );
        const { captureDir, result } = runSurvivor(
          {
            BASH_ENV: prelude,
            FIXTURE_PAYLOAD_SHELL: shell,
            OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "0",
          },
          shell,
        );
        expect(existsSync(join(captureDir, "docker-run-args"))).toBe(true);
        expect(result.status, result.stderr).toBe(1);
        expectFinalFailure(result.stderr, 1);
        expect(result.stderr).toContain("before all assertions completed");
        expect(result.stdout).not.toContain("Docker E2E passed");
      });
    },
  );

  it.each(["direct", "published"] as const)(
    "preserves an explicitly supplied %s registry",
    (mode) => {
      const registryDir = tempDirs.make("openclaw-external-plugin-registry-");
      const manifestPath = join(registryDir, "prepublish-plugin-registry.json");
      writeFileSync(manifestPath, registryManifest());

      const { captureDir, result } = runSurvivor({
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registryDir,
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: createHash("sha256")
          .update(readFileSync(manifestPath))
          .digest("hex"),
        ...(mode === "direct"
          ? {
              OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: undefined,
              OPENCLAW_UPGRADE_SURVIVOR_PUBLISHED_BASELINE: "0",
              OPENCLAW_UPGRADE_SURVIVOR_UPDATE_RESTART_MODE: "auto-auth",
            }
          : { OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "external-only-scenario" }),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(captureDir, "node-args"))).toBe(false);
      expect(readFileSync(join(captureDir, "docker-args"), "utf8")).toContain(
        `${registryDir}:/tmp/openclaw-prepublish-plugin-registry:ro`,
      );
    },
  );

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
    expectFinalFailure(result.stderr, 2);
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
