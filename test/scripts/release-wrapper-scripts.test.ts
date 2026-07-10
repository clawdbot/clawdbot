// Release wrapper script tests keep changed-target routing tied to scripts that load the wrappers.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const UNKNOWN_PACKAGE = "@openclaw/not-a-real-release-wrapper-test-package";
const tempDirs: string[] = [];
const tsxImport = import.meta.resolve("tsx");

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runTsxScript(scriptPath: string, args: string[], cwd = process.cwd()) {
  return spawnSync(process.execPath, ["--import", tsxImport, scriptPath, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function createOldReleaseTarget() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-old-release-target-"));
  tempDirs.push(root);
  mkdirSync(join(root, "extensions"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "openclaw", version: "2026.7.1-beta.3" }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "scripts", "openclaw-release-clawhub-plan.ts"),
    'throw new Error("old target planner invoked");\n',
  );
  writeFileSync(
    join(root, "scripts", "release-verify-beta.ts"),
    'throw new Error("old target verifier invoked");\n',
  );
  return root;
}

describe("release wrapper scripts", () => {
  it("runs plugin release wrapper CLIs and rejects unknown explicit selections", () => {
    for (const scriptPath of [
      "scripts/plugin-npm-release-plan.ts",
      "scripts/plugin-npm-release-check.ts",
      "scripts/plugin-clawhub-release-plan.ts",
      "scripts/plugin-clawhub-release-check.ts",
    ]) {
      const result = runTsxScript(scriptPath, ["--plugins", UNKNOWN_PACKAGE]);

      expect(result.status, scriptPath).toBe(1);
      expect(result.stderr, scriptPath).toContain(
        `Unknown or non-publishable plugin package selection: ${UNKNOWN_PACKAGE}.`,
      );
      expect(result.stdout, scriptPath).toBe("");
    }
  });

  it("loads the OpenClaw ClawHub plan CLI and validates required arguments before planning", () => {
    const result = runTsxScript("scripts/openclaw-release-clawhub-plan.ts", [
      "--bootstrap-workflow-sha",
      "b".repeat(40),
      "--release-tag",
      "v2026.6.21-beta.1",
      "--release-sha",
      "a".repeat(40),
      "--release-publish-run-attempt",
      "1",
      "--release-publish-run-id",
      "123",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--release-publish-branch is required.");
    expect(result.stdout).toBe("");
  });

  it("runs trusted harness planning and verification against an old release target cwd", () => {
    const oldTarget = createOldReleaseTarget();
    const repositoryRoot = process.cwd();
    const releaseSha = "a".repeat(40);
    const plan = runTsxScript(
      join(repositoryRoot, "scripts/openclaw-release-clawhub-plan.ts"),
      [
        "--bootstrap-workflow-sha",
        "b".repeat(40),
        "--release-tag",
        "v2026.7.1-beta.3",
        "--release-sha",
        releaseSha,
        "--release-publish-branch",
        "main",
        "--release-publish-run-attempt",
        "1",
        "--release-publish-run-id",
        "123",
        "--plugin-publish-scope",
        "all-publishable",
      ],
      oldTarget,
    );
    expect(plan.status).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({
      bootstrapWorkflowSha: "b".repeat(40),
      bootstrap: { ref: "main", shouldDispatch: false },
      normal: { ref: "v2026.7.1-beta.3", shouldDispatch: false },
    });
    expect(plan.stderr).not.toContain("old target planner invoked");

    const verify = runTsxScript(
      join(repositoryRoot, "scripts/release-verify-beta.ts"),
      [
        "2026.7.1-beta.4",
        "--release-sha",
        releaseSha,
        "--clawhub-bootstrap-plugins",
        "@openclaw/meta",
        "--plugin-clawhub-bootstrap-run",
        "34",
      ],
      oldTarget,
    );
    expect(verify.status).toBe(1);
    expect(verify.stderr).toContain(
      "package.json version is 2026.7.1-beta.3; expected 2026.7.1-beta.4.",
    );
    expect(verify.stderr).not.toContain("old target verifier invoked");
    expect(verify.stderr).not.toContain("Unknown argument");
  });

  it("loads the beta verifier CLI and validates required version input before remote checks", () => {
    const result = runTsxScript("scripts/release-verify-beta.ts", ["--skip-clawhub"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: pnpm release:verify-beta -- <version>");
    expect(result.stdout).toBe("");
  });
});
