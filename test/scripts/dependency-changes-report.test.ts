// Dependency Changes Report tests cover dependency changes report script behavior.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDependencyChangesReport,
  dependencyDiffPathspecs,
  isDependencyFile,
  parseArgs,
} from "../../scripts/dependency-changes-report.mts";

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/dependency-changes-report.mts", ...args],
    {
      cwd: path.resolve("."),
      encoding: "utf8",
    },
  );
}

function expectNoNodeStack(stderr: string) {
  expect(stderr).not.toContain("Node.js");
  expect(stderr).not.toContain("\n    at ");
}

describe("dependency-changes-report", () => {
  it("reports added, removed, and changed packages", () => {
    const report = createDependencyChangesReport({
      basePayload: {
        removed: ["1.0.0"],
        stable: ["1.0.0"],
        changed: ["1.0.0"],
      },
      headPayload: {
        added: ["1.0.0"],
        stable: ["1.0.0"],
        changed: ["2.0.0"],
      },
      dependencyFileChanges: [
        { status: "M", path: "pnpm-lock.yaml", oldPath: null },
        { status: "M", path: "pnpm-workspace.yaml", oldPath: null },
      ],
      generatedAt: "2026-05-12T00:00:00Z",
    });

    expect(report.summary).toEqual({
      basePackages: 3,
      headPackages: 3,
      addedPackages: 1,
      removedPackages: 1,
      changedPackages: 1,
      dependencyFileChanges: 2,
    });
    expect(report.dependencyFileChanges).toEqual([
      { status: "M", path: "pnpm-lock.yaml", oldPath: null },
      { status: "M", path: "pnpm-workspace.yaml", oldPath: null },
    ]);
    expect(report.addedPackages).toEqual([{ packageName: "added", versions: ["1.0.0"] }]);
    expect(report.removedPackages).toEqual([{ packageName: "removed", versions: ["1.0.0"] }]);
    expect(report.changedPackages).toEqual([
      { packageName: "changed", addedVersions: ["2.0.0"], removedVersions: ["1.0.0"] },
    ]);
  });

  it("treats committed dependency locks as dependency files", () => {
    expect(isDependencyFile("pnpm-lock.yaml")).toBe(true);
    expect(isDependencyFile(".github/release/clawhub-cli/package-lock.json")).toBe(true);
    expect(isDependencyFile(".github/release/vercel-cli/package-lock.json")).toBe(true);
    expect(isDependencyFile("extensions/discord/package-lock.json")).toBe(false);
    expect(isDependencyFile("docs/gateway/security/index.md")).toBe(false);
  });

  it("includes committed dependency locks in git diff pathspecs", () => {
    expect(dependencyDiffPathspecs()).toContain("pnpm-lock.yaml");
    expect(dependencyDiffPathspecs()).toContain(".github/release/clawhub-cli/package-lock.json");
    expect(dependencyDiffPathspecs()).toContain(".github/release/vercel-cli/package-lock.json");
  });

  it.each([
    {
      name: "git ref",
      baseArgs: ["--base-ref", "origin/main"],
      expectedBaseRef: "origin/main",
      expectedBaseLockfile: null,
    },
    {
      name: "lockfile",
      baseArgs: ["--base-lockfile", "base-lock.yaml"],
      expectedBaseRef: null,
      expectedBaseLockfile: "base-lock.yaml",
    },
  ])("parses all report options with a $name base", (testCase) => {
    expect(
      parseArgs([
        "--root",
        "/repo",
        ...testCase.baseArgs,
        "--head-lockfile",
        "head-lock.yaml",
        "--json",
        "artifacts/report.json",
        "--",
        "--markdown",
        "artifacts/report.md",
      ]),
    ).toEqual({
      rootDir: "/repo",
      baseRef: testCase.expectedBaseRef,
      baseLockfile: testCase.expectedBaseLockfile,
      headLockfile: "head-lock.yaml",
      jsonPath: "artifacts/report.json",
      markdownPath: "artifacts/report.md",
    });
  });

  it("rejects missing report artifact path option values", () => {
    for (const flag of [
      "--root",
      "--base-ref",
      "--base-lockfile",
      "--head-lockfile",
      "--json",
      "--markdown",
    ]) {
      expect(() => parseArgs([flag, "--json"])).toThrow(`${flag} requires a value`);
      expect(() => parseArgs([flag, "-h"])).toThrow(`${flag} requires a value`);
    }
  });

  it("rejects duplicate and conflicting dependency report inputs", () => {
    for (const flag of [
      "--root",
      "--base-ref",
      "--base-lockfile",
      "--head-lockfile",
      "--json",
      "--markdown",
    ]) {
      expect(() => parseArgs(["--base-ref", "main", flag, "one", flag, "two"])).toThrow(
        `${flag} was provided more than once.`,
      );
    }
    expect(() => parseArgs(["--base-ref", "main", "--base-lockfile", "base-lock.yaml"])).toThrow(
      "Use either --base-ref or --base-lockfile, not both.",
    );
  });

  it("reports CLI argument errors without a Node stack trace", () => {
    const missingBase = runCli();
    expect(missingBase.status).toBe(1);
    expect(missingBase.stdout).toBe("");
    expect(missingBase.stderr.trim()).toBe(
      "Expected --base-ref <git-ref> or --base-lockfile <path>.",
    );
    expectNoNodeStack(missingBase.stderr);

    const unknownArg = runCli("--wat");
    expect(unknownArg.status).toBe(1);
    expect(unknownArg.stdout).toBe("");
    expect(unknownArg.stderr.trim()).toBe("Unsupported argument: --wat");
    expectNoNodeStack(unknownArg.stderr);
  });
});
