import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectChangedScope } from "../../scripts/ci-changed-scope.mjs";
import { isDirectRunPath } from "../../scripts/lib/direct-run.mjs";

const DIRECT_RUN_SCRIPTS = [
  "scripts/android-app-i18n.ts",
  "scripts/android-pin-version.ts",
  "scripts/ci-run-timings.mjs",
  "scripts/e2e/lib/package-compat.mjs",
  "scripts/generate-bundled-channel-config-metadata.ts",
  "scripts/plan-release-workflow-matrix.mjs",
  "scripts/run-additional-boundary-checks.mjs",
  "scripts/verify-docker-attestations.mjs",
] as const;

const EXECUTABLE_ENTRYPOINTS = [
  {
    args: ["--direct-run-smoke"],
    output: "Unknown CI run timing option: --direct-run-smoke",
    script: "scripts/ci-run-timings.mjs",
    status: 1,
  },
  {
    args: ["2026.4.25"],
    output: "1",
    script: "scripts/e2e/lib/package-compat.mjs",
    status: 0,
  },
  {
    args: [],
    output: "docker_e2e_count=",
    script: "scripts/plan-release-workflow-matrix.mjs",
    status: 0,
  },
  {
    args: ["--help"],
    output: "Usage: node scripts/run-additional-boundary-checks.mjs",
    script: "scripts/run-additional-boundary-checks.mjs",
    status: 0,
  },
  {
    args: ["--help"],
    output: "Usage: node scripts/verify-docker-attestations.mjs",
    script: "scripts/verify-docker-attestations.mjs",
    status: 0,
  },
] as const;

function runEntrypoint(entrypoint: (typeof EXECUTABLE_ENTRYPOINTS)[number]) {
  return spawnSync(process.execPath, [path.resolve(entrypoint.script), ...entrypoint.args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DOCKER_LANES: "",
      GITHUB_STEP_SUMMARY: "",
      INCLUDE_LIVE_SUITES: "",
      INCLUDE_RELEASE_PATH_SUITES: "",
      LIVE_MODEL_PROVIDERS: "",
      LIVE_SUITE_FILTER: "",
      RELEASE_TEST_PROFILE: "",
    },
    timeout: 30_000,
  });
}

describe("script direct-run entrypoints", () => {
  it.each(EXECUTABLE_ENTRYPOINTS)("runs $script through its guarded CLI", (entrypoint) => {
    const result = runEntrypoint(entrypoint);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(entrypoint.status);
    expect(output).toContain(entrypoint.output);
  });

  it("matches Windows drive paths case-insensitively", () => {
    expect(
      isDirectRunPath(
        "C:\\repo\\scripts\\android-app-i18n.ts",
        "c:\\repo\\scripts\\android-app-i18n.ts",
        "win32",
      ),
    ).toBe(true);
  });

  it.each(DIRECT_RUN_SCRIPTS)("uses the canonical guard in %s", (script) => {
    const source = readFileSync(script, "utf8");

    expect(source.match(/isDirectRunUrl\(process\.argv\[1\], import\.meta\.url\)/gu)).toHaveLength(
      1,
    );
  });

  it.each([
    ...DIRECT_RUN_SCRIPTS,
    "scripts/lib/direct-run.mjs",
    "test/scripts/direct-run-entrypoints.test.ts",
  ])("routes %s through Windows CI", (changedPath) => {
    expect(detectChangedScope([changedPath]).runWindows).toBe(true);
  });
});
