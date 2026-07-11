// Generate Dependency Release Evidence tests cover generate dependency release evidence script behavior.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPENDENCY_EVIDENCE_REPORTS,
  collectDependencyEvidenceSummaryCounts,
  createDependencyEvidenceManifest,
  parseArgs,
  renderDependencyEvidenceStepSummary,
  renderDependencyEvidenceSummary,
  resolvePreviousReleaseTag,
  resolveReleaseTag,
} from "../../scripts/generate-dependency-release-evidence.mjs";

async function writeJson(dir: string, fileName: string, value: unknown) {
  await writeFile(path.join(dir, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ["scripts/generate-dependency-release-evidence.mjs", ...args],
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

describe("generate-dependency-release-evidence", () => {
  it("defines the release evidence command list and policy classifications", () => {
    expect(DEPENDENCY_EVIDENCE_REPORTS.map(({ command, policy }) => ({ command, policy }))).toEqual(
      [
        { command: "pnpm deps:vuln:gate", policy: "hard-blocking" },
        { command: "pnpm deps:transitive-risk:report", policy: "report-only" },
        { command: "pnpm deps:ownership-surface:report", policy: "report-only" },
        { command: "pnpm deps:changes:report", policy: "report-only" },
      ],
    );
  });

  it("creates the dependency evidence manifest shape", () => {
    const manifest = createDependencyEvidenceManifest({
      generatedAt: "2026-05-13T00:00:00.000Z",
      releaseTag: "v2026.5.13-beta.1",
      releaseRef: "v2026.5.13-beta.1",
      releaseSha: "abc123",
      npmDistTag: "beta",
      packageVersion: "2026.5.13-beta.1",
      workflowRunId: "123",
      workflowRunAttempt: "2",
      dependencyChangeBaseRef: "v2026.5.1",
    });

    expect(manifest).toEqual({
      schemaVersion: 1,
      generatedAt: "2026-05-13T00:00:00.000Z",
      releaseTag: "v2026.5.13-beta.1",
      releaseRef: "v2026.5.13-beta.1",
      releaseSha: "abc123",
      npmDistTag: "beta",
      packageName: "openclaw",
      packageVersion: "2026.5.13-beta.1",
      workflowRunId: "123",
      workflowRunAttempt: "2",
      dependencyChangeBaseRef: "v2026.5.1",
      reports: DEPENDENCY_EVIDENCE_REPORTS,
    });
  });

  it("uses a synthetic release tag for validation-only SHA preflight input", () => {
    expect(
      resolveReleaseTag({
        releaseRef: "0123456789abcdef0123456789abcdef01234567",
        packageVersion: "2026.5.13",
      }),
    ).toBe("v2026.5.13");
    expect(
      resolveReleaseTag({
        releaseRef: "v2026.5.13-beta.1",
        packageVersion: "2026.5.13-beta.1",
      }),
    ).toBe("v2026.5.13-beta.1");
  });

  it("rejects missing dependency evidence CLI option values", () => {
    const requiredArgs = ["--release-ref", "v2026.5.13", "--npm-dist-tag", "latest"];
    expect(() =>
      parseArgs(["--output-dir", "--release-ref", "v2026.5.13", "--npm-dist-tag", "latest"]),
    ).toThrow("Expected --output-dir <value>.");
    expect(() => parseArgs(["--output-dir", "-h", ...requiredArgs])).toThrow(
      "Expected --output-dir <value>.",
    );
    expect(() =>
      parseArgs(["--output-dir", "evidence", "--release-ref", "--npm-dist-tag", "latest"]),
    ).toThrow("Expected --release-ref <value>.");
    expect(() =>
      parseArgs(["--output-dir", "evidence", "--release-ref", "-h", "--npm-dist-tag", "latest"]),
    ).toThrow("Expected --release-ref <value>.");
    expect(() =>
      parseArgs([
        "--output-dir",
        "evidence",
        "--release-ref",
        "v2026.5.13",
        "--npm-dist-tag",
        "-h",
      ]),
    ).toThrow("Expected --npm-dist-tag <value>.");
    expect(() =>
      parseArgs(["--output-dir", "evidence", "--release-ref", "v2026.5.13", "--base-ref"]),
    ).toThrow("Expected --base-ref <value>.");
    expect(() =>
      parseArgs(["--output-dir", "evidence", ...requiredArgs, "--base-ref", "-h"]),
    ).toThrow("Expected --base-ref <value>.");
    expect(() =>
      parseArgs([
        "--output-dir",
        "evidence",
        "--release-ref",
        "v2026.5.13",
        "--npm-dist-tag",
        "latest",
        "--github-output",
        "--github-step-summary",
        "summary.md",
      ]),
    ).toThrow("Expected --github-output <value>.");
    expect(() =>
      parseArgs(["--output-dir", "evidence", ...requiredArgs, "--github-output", "-h"]),
    ).toThrow("Expected --github-output <value>.");
  });

  it("rejects duplicate dependency evidence CLI options", () => {
    const requiredArgs = ["--release-ref", "v2026.5.13", "--npm-dist-tag", "latest"];
    const artifactArgs = ["--output-dir", "evidence", ...requiredArgs];
    const duplicateCases = [
      ["--root", ["--root", "repo-a", "--root", "repo-b", ...artifactArgs]],
      [
        "--output-dir",
        ["--output-dir", "evidence-a", "--output-dir", "evidence-b", ...requiredArgs],
      ],
      [
        "--release-ref",
        [
          "--output-dir",
          "evidence",
          "--release-ref",
          "v2026.5.13",
          "--release-ref",
          "v2026.5.14",
          "--npm-dist-tag",
          "latest",
        ],
      ],
      [
        "--npm-dist-tag",
        [
          "--output-dir",
          "evidence",
          "--release-ref",
          "v2026.5.13",
          "--npm-dist-tag",
          "latest",
          "--npm-dist-tag",
          "beta",
        ],
      ],
      ["--base-ref", [...artifactArgs, "--base-ref", "origin/main", "--base-ref", "HEAD~1"]],
      [
        "--github-output",
        [...artifactArgs, "--github-output", "first.out", "--github-output", "second.out"],
      ],
      [
        "--github-step-summary",
        [
          ...artifactArgs,
          "--github-step-summary",
          "first.md",
          "--github-step-summary",
          "second.md",
        ],
      ],
    ] satisfies Array<[string, string[]]>;

    for (const [flag, args] of duplicateCases) {
      expect(() => parseArgs(args)).toThrow(`${flag} was provided more than once.`);
    }
  });

  it("prints CLI help without generating evidence", () => {
    const result = runCli("--help");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node scripts/generate-dependency-release-evidence.mjs");
    expect(result.stderr).toBe("");
  });

  it("reports CLI argument errors without a Node stack trace", () => {
    const result = runCli("--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unsupported argument: --wat");
    expectNoNodeStack(result.stderr);
  });

  it("falls back to fetching tags when local previous-release resolution misses", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    let describeCalls = 0;
    const execFileSyncImpl = (command: string, args: string[] = []) => {
      calls.push({ command, args });
      if (command !== "git") {
        throw new Error(`unexpected command: ${command}`);
      }
      if (args[0] === "describe") {
        describeCalls += 1;
        if (describeCalls === 1) {
          throw new Error("tag not found");
        }
        return "v2026.5.1\n";
      }
      if (args[0] === "fetch") {
        return "";
      }
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    };

    expect(
      resolvePreviousReleaseTag({
        rootDir: "/repo",
        execFileSyncImpl,
      }),
    ).toBe("v2026.5.1");
    expect(calls.map(({ args }) => args[0])).toEqual(["describe", "fetch", "describe"]);
    expect(calls[1].args).toEqual(["fetch", "--tags", "--force", "origin"]);
  });

  it("collects report counts and renders human summaries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-release-dependency-evidence-test-"));
    try {
      await writeJson(dir, "dependency-vulnerability-gate.json", {
        blockers: [{ id: "GHSA-blocker" }],
        findings: [{ id: "GHSA-blocker" }, { id: "GHSA-report" }],
      });
      await writeJson(dir, "transitive-manifest-risk-report.json", {
        findingCount: 17,
        workspaceExcludedFindingCount: 3,
        metadataFailures: [{ packageName: "missing" }],
      });
      await writeJson(dir, "dependency-ownership-surface-report.json", {
        summary: {
          lockfilePackageCount: 101,
          buildRiskPackageCount: 8,
        },
      });
      await writeJson(dir, "dependency-changes-report.json", {
        summary: {
          dependencyFileChanges: 4,
          addedPackages: 5,
          removedPackages: 6,
          changedPackages: 7,
        },
      });

      const counts = await collectDependencyEvidenceSummaryCounts(dir);
      expect(counts).toEqual({
        vulnerabilityBlockers: 1,
        vulnerabilityFindings: 2,
        transitiveRiskSignals: 17,
        workspaceExcludedTransitiveSignals: 3,
        transitiveMetadataFailures: 1,
        ownershipLockfilePackages: 101,
        ownershipBuildRiskPackages: 8,
        dependencyFileChanges: 4,
        dependencyAddedPackages: 5,
        dependencyRemovedPackages: 6,
        dependencyChangedPackages: 7,
      });

      const summary = renderDependencyEvidenceSummary({
        releaseTag: "v2026.5.13",
        releaseSha: "abc123",
        baseRef: "v2026.5.1",
        counts,
      });
      expect(summary).toContain("- npm advisory vulnerability hard blockers: 1");
      expect(summary).toContain("- Transitive manifest reported risk signals: 17");
      expect(summary).toContain("- Dependency change baseline: `v2026.5.1`");
      expect(summary).toContain("- Resolved package changes: +5 -6 changed 7");

      const stepSummary = renderDependencyEvidenceStepSummary({
        evidenceArtifactName: "openclaw-release-dependency-evidence-v2026.5.13",
        baseRef: "v2026.5.1",
        counts,
      });
      expect(stepSummary).toContain(
        "- Evidence artifact: `openclaw-release-dependency-evidence-v2026.5.13`",
      );
      expect(stepSummary).toContain("- npm advisory vulnerability hard blockers: `1`");

      await expect(
        readFile(path.join(dir, "dependency-vulnerability-gate.json"), "utf8"),
      ).resolves.toContain("GHSA-blocker");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
