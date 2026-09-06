import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// Release prepare tests cover shadow planning, cutover commands, and candidate manifests.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  buildReleasePreparationManifest,
  createReleasePrepareSteps,
  parseReleasePrepareArgs,
  readWorktreeState,
  runReleasePrepareSteps,
} from "../../scripts/release-prepare.ts";

function worktreeState(
  overrides: Partial<{
    changedFiles: string[];
    fingerprint: string;
    head: string;
    packageVersion: string;
    status: string;
  }> = {},
) {
  return {
    changedFiles: [],
    fingerprint: "f".repeat(64),
    head: "a".repeat(40),
    packageVersion: "2026.6.11",
    status: "",
    ...overrides,
  };
}

describe("release preparation arguments", () => {
  it("defaults to non-mutating shadow mode", () => {
    expect(parseReleasePrepareArgs(["--version", "2026.7.2-beta.1"])).toMatchObject({
      android: false,
      jobs: 4,
      mode: "shadow",
      version: "2026.7.2-beta.1",
    });
  });

  it("rejects ambiguous modes and invalid concurrency", () => {
    expect(() => parseReleasePrepareArgs(["--version", "2026.7.2", "--check", "--write"])).toThrow(
      "Use only one mode flag",
    );
    expect(() => parseReleasePrepareArgs(["--version", "2026.7.2", "--jobs", "17"])).toThrow(
      "Expected 1 through 16",
    );
  });
});

describe("release preparation plan", () => {
  it("builds the write cutover from atomic versioning and scoped preflight", () => {
    const steps = createReleasePrepareSteps({
      android: true,
      jobs: 6,
      mode: "write",
      rootDir: "/repo",
      version: "2026.7.2-beta.1",
    });

    expect(expectDefined(steps[0], "release version preparation step").args).toEqual([
      "--import",
      "tsx",
      "scripts/release-version.ts",
      "--root",
      "/repo",
      "--version",
      "2026.7.2-beta.1",
      "--android",
      "--write",
    ]);
    expect(expectDefined(steps[1], "release preflight preparation step").args).toEqual([
      "scripts/release-preflight.mjs",
      "--fix",
      "--scope",
      "version",
      "--jobs",
      "6",
    ]);
  });

  it("does not execute commands in shadow mode", () => {
    const steps = createReleasePrepareSteps({
      android: false,
      jobs: 4,
      mode: "shadow",
      rootDir: "/repo",
      version: "2026.7.2",
    });
    let calls = 0;
    const results = runReleasePrepareSteps({
      cwd: "/repo",
      mode: "shadow",
      runStep: () => {
        calls += 1;
        return 0;
      },
      steps,
    });

    expect(calls).toBe(0);
    expect(results.map((result) => result.status)).toEqual(["planned", "planned"]);
  });

  it("stops after a failed prerequisite and records the blocked step", () => {
    const steps = createReleasePrepareSteps({
      android: false,
      jobs: 4,
      mode: "check",
      rootDir: "/repo",
      version: "2026.7.2",
    });
    const results = runReleasePrepareSteps({
      cwd: "/repo",
      mode: "check",
      runStep: () => 1,
      steps,
    });

    expect(results.map((result) => result.status)).toEqual(["failed", "skipped"]);
  });

  it("streams large JSON-mode child output to stderr without buffering", () => {
    const childScript = [
      'const { writeSync } = require("node:fs");',
      'writeSync(1, "child stdout begin\\n" + "x".repeat(2 * 1024 * 1024) + "\\nchild stdout end\\n");',
      'writeSync(2, "child stderr sentinel\\n");',
      "process.exit(23);",
    ].join("");
    const harness = `
      import { runReleasePrepareStep } from ${JSON.stringify(new URL("../../scripts/release-prepare.ts", import.meta.url).href)};
      const status = runReleasePrepareStep(
        { args: ["-e", ${JSON.stringify(childScript)}], command: process.execPath, id: "release-version", name: "JSON child" },
        process.cwd(),
        { json: true },
      );
      process.exitCode = status;
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", harness],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(23);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[release-prepare] JSON child");
    expect(result.stderr).toContain("child stdout begin");
    expect(result.stderr).toContain("child stdout end");
    expect(result.stderr).toContain("child stderr sentinel");
    expect(Buffer.byteLength(result.stderr)).toBeGreaterThan(2 * 1024 * 1024);
  });
});

describe("release preparation manifest", () => {
  it("fingerprints complete generated diffs beyond the former capture limit", async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "openclaw-release-prepare-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: rootDir });
      execFileSync("git", ["config", "user.email", "release-test@openclaw.invalid"], {
        cwd: rootDir,
      });
      execFileSync("git", ["config", "user.name", "OpenClaw Release Test"], { cwd: rootDir });
      writeFileSync(path.join(rootDir, "package.json"), '{"version":"2026.7.2"}\n');
      writeFileSync(path.join(rootDir, "generated.txt"), `${"a".repeat(33 * 1024 * 1024)}\n`);
      execFileSync("git", ["add", "."], { cwd: rootDir });
      execFileSync("git", ["commit", "-q", "-m", "test fixture"], { cwd: rootDir });
      const generated = "b".repeat(33 * 1024 * 1024);
      writeFileSync(path.join(rootDir, "generated.txt"), `${generated}\n`);

      const state = await readWorktreeState(rootDir);

      expect(state.changedFiles).toEqual(["generated.txt"]);
      expect(state.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
      writeFileSync(path.join(rootDir, "generated.txt"), `${generated}changed-tail\n`);
      const changedTail = await readWorktreeState(rootDir);
      expect(changedTail.fingerprint).not.toBe(state.fingerprint);
    } finally {
      rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it("binds the plan to the exact source and worktree fingerprint", () => {
    const steps = runReleasePrepareSteps({
      cwd: "/repo",
      mode: "shadow",
      steps: createReleasePrepareSteps({
        android: false,
        jobs: 4,
        mode: "shadow",
        rootDir: "/repo",
        version: "2026.7.2",
      }),
    });
    const manifest = buildReleasePreparationManifest({
      after: worktreeState({
        changedFiles: ["package.json"],
        fingerprint: "b".repeat(64),
      }),
      before: worktreeState(),
      mode: "shadow",
      steps,
      version: "2026.7.2",
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      requestedVersion: "2026.7.2",
      mode: "shadow",
      status: "shadow",
      sourceHead: "a".repeat(40),
      candidateFingerprint: "b".repeat(64),
    });
    expect(manifest.steps.map((step) => step.status)).toEqual(["planned", "planned"]);
  });
});
