// Generate Dependency Release Evidence tests cover generate dependency release evidence script behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
} from "../../scripts/generate-dependency-release-evidence.mts";
import {
  RELEASE_DEPENDENCY_RISK_LOCKFILES,
  resolveReleaseDependencyRiskAcceptance,
} from "../../scripts/lib/release-dependency-risk-acceptance.mts";

async function writeJson(dir: string, fileName: string, value: unknown) {
  await writeFile(path.join(dir, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runCli(args: string[], env = process.env) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/generate-dependency-release-evidence.mts", ...args],
    {
      cwd: path.resolve("."),
      env,
      encoding: "utf8",
    },
  );
}

function expectNoNodeStack(stderr: string) {
  expect(stderr).not.toContain("Node.js");
  expect(stderr).not.toContain("\n    at ");
}

describe("generate-dependency-release-evidence", () => {
  function acceptedRiskInput(): Parameters<typeof resolveReleaseDependencyRiskAcceptance>[0] {
    return {
      packageVersion: "2026.9.1",
      lockfileSha256: { ...RELEASE_DEPENDENCY_RISK_LOCKFILES },
      blockers: [
        ...["GHSA-58mr-gqgx-xq4g", "GHSA-qw65-cvwx-89v3"].flatMap((id) =>
          [
            { lockfile: "pnpm-lock.yaml", matchedVersions: ["4.1.3"] },
            {
              lockfile: ".github/release/vercel-cli/package-lock.json",
              matchedVersions: ["3.1.6"],
            },
          ].map(({ lockfile, matchedVersions }) => ({
            lockfile,
            matchedVersions,
            packageName: "fast-uri",
            id,
            severity: "high" as const,
            graph: "production" as const,
            malware: false,
            source: "github-repository" as const,
            title: "URI authority validation",
            url: `https://github.com/fastify/fast-uri/security/advisories/${id}`,
            vulnerableVersions: "<4.1.4",
          })),
        ),
        {
          lockfile: "pnpm-lock.yaml",
          packageName: "nodemailer",
          matchedVersions: ["9.0.4", "9.0.5"],
          id: "GHSA-2x7j-588g-ccc2",
          severity: "high",
          graph: "production",
          malware: false,
          source: "github-repository",
          title: "Address list denial of service",
          url: "https://github.com/nodemailer/nodemailer/security/advisories/GHSA-2x7j-588g-ccc2",
          vulnerableVersions: "<9.1.0",
        },
      ],
    };
  }

  it("retains every accepted advisory and exact graph binding without declaring the scan clean", () => {
    const input = acceptedRiskInput();
    const original = structuredClone(input);
    const acceptance = resolveReleaseDependencyRiskAcceptance(input);
    expect(acceptance).toMatchObject({
      kind: "operator-accepted-dependency-risk",
      packageVersion: "2026.9.1",
      blockers: original.blockers,
      lockfileSha256: original.lockfileSha256,
    });
    expect(input).toEqual(original);
  });

  it("never carries acceptance to another release, graph, or unaccepted finding", () => {
    const mutations = [
      (input: ReturnType<typeof acceptedRiskInput>) => {
        input.packageVersion = "2026.9.2";
      },
      (input: ReturnType<typeof acceptedRiskInput>) => {
        input.lockfileSha256["pnpm-lock.yaml"] = "changed";
      },
      (input: ReturnType<typeof acceptedRiskInput>) => {
        input.blockers[0]!.severity = "critical";
      },
      (input: ReturnType<typeof acceptedRiskInput>) => {
        input.blockers[0]!.malware = true;
      },
      (input: ReturnType<typeof acceptedRiskInput>) => {
        input.blockers[0]!.id = "GHSA-unaccepted";
      },
      (input: ReturnType<typeof acceptedRiskInput>) => {
        input.blockers[0]!.matchedVersions = ["4.1.2"];
      },
      (input: ReturnType<typeof acceptedRiskInput>) => {
        input.blockers.push({ ...input.blockers[0]! });
      },
      (input: ReturnType<typeof acceptedRiskInput>) => {
        input.blockers[0] = { ...input.blockers[1]! };
      },
    ];
    for (const mutate of mutations) {
      const input = acceptedRiskInput();
      mutate(input);
      expect(resolveReleaseDependencyRiskAcceptance(input)).toBeNull();
    }
  });

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
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Usage: node --import tsx scripts/generate-dependency-release-evidence.mts",
    );
    expect(result.stderr).toBe("");
  });

  it("reports CLI argument errors without a Node stack trace", () => {
    for (const args of [["--wat"], ["wat", "--help"]]) {
      const result = runCli(args);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe(
        `Unsupported argument: ${args[0]}\n[dependency-release-evidence] FAILED (exit 1)`,
      );
      expectNoNodeStack(result.stderr);
    }
  });

  it.skipIf(process.platform === "win32")(
    "uses trusted report tooling for a separate target and retains blocking evidence",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "openclaw-release-dependency-failure-test-"));
      try {
        const binDir = path.join(dir, "bin");
        const outputDir = path.join(dir, "evidence");
        const sourceDir = path.join(dir, "candidate");
        const marker = path.join(dir, "pnpm-cwd");
        const githubOutput = path.join(dir, "github-output");
        await mkdir(binDir);
        await mkdir(sourceDir);
        await writeJson(sourceDir, "package.json", { version: "2026.5.13" });
        await writeFile(
          path.join(binDir, "git"),
          '#!/usr/bin/env node\nconsole.log("a".repeat(40));\n',
          { mode: 0o755 },
        );
        await writeFile(
          path.join(binDir, "pnpm"),
          [
            "#!/usr/bin/env node",
            'const { writeFileSync } = require("node:fs");',
            "const args = process.argv.slice(2);",
            "writeFileSync(process.env.RELEASE_TEST_MARKER, process.cwd());",
            'if (args[0] !== "deps:vuln:gate") throw new Error("Wrong report command");',
            'if (args[args.indexOf("--root") + 1] !== process.env.RELEASE_TEST_SOURCE_ROOT) throw new Error("Wrong report target");',
            'writeFileSync(args[args.indexOf("--json") + 1], JSON.stringify({ blockers: [{ id: "GHSA-fixture" }] }));',
            'writeFileSync(args[args.indexOf("--markdown") + 1], "# Blocking advisory evidence\\n");',
            "process.exitCode = 1;",
          ].join("\n"),
          { mode: 0o755 },
        );

        const result = runCli(
          [
            "--root",
            sourceDir,
            "--output-dir",
            outputDir,
            "--release-ref",
            "v2026.5.13",
            "--npm-dist-tag",
            "latest",
            "--base-ref",
            "v2026.5.1",
            "--github-output",
            githubOutput,
            "--github-step-summary",
            "",
          ],
          {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            RELEASE_TEST_SOURCE_ROOT: sourceDir,
            RELEASE_TEST_MARKER: marker,
          },
        );

        await expect(readFile(marker, "utf8")).resolves.toBe(path.resolve("."));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Command failed: pnpm deps:vuln:gate");
        await expect(readFile(githubOutput, "utf8")).resolves.toBe(`dir=${outputDir}\n`);
        await expect(
          readFile(path.join(outputDir, "dependency-vulnerability-gate.json"), "utf8"),
        ).resolves.toBe(JSON.stringify({ blockers: [{ id: "GHSA-fixture" }] }));
        await expect(
          readFile(path.join(outputDir, "dependency-vulnerability-gate.md"), "utf8"),
        ).resolves.toBe("# Blocking advisory evidence\n");
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
  );

  it.each([true, false])(
    "fetches complete target release history without unrelated refs (shallow=%s)",
    async (shallow) => {
      const dir = await mkdtemp(path.join(tmpdir(), "openclaw-release-history-test-"));
      const git = (cwd: string, ...args: string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=Release test",
            "-c",
            "user.email=release-test@example.invalid",
            "-c",
            "commit.gpgSign=false",
            ...args,
          ],
          { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ).trim();
      try {
        const origin = path.join(dir, "origin");
        const target = path.join(dir, "target");
        await mkdir(origin);
        await mkdir(target);
        git(origin, "init", "--quiet", "--initial-branch=main");
        git(origin, "config", "uploadpack.allowFilter", "true");
        git(origin, "commit", "--quiet", "--allow-empty", "-m", "previous release");
        git(origin, "tag", "--no-sign", "-a", "v2026.5.1", "-m", "previous release");
        git(origin, "commit", "--quiet", "--allow-empty", "-m", "release target");
        const releaseSha = git(origin, "rev-parse", "HEAD");
        git(origin, "branch", "release-target");
        git(origin, "commit", "--quiet", "--allow-empty", "-m", "later main release");
        git(origin, "tag", "--no-sign", "v2026.6.1");
        git(origin, "tag", "--no-sign", "release-tooling-unrelated");
        git(origin, "branch", "unrelated");
        git(target, "init", "--quiet", "--initial-branch=consumer");
        git(target, "remote", "add", "origin", pathToFileURL(origin).href);
        git(target, "fetch", "--no-tags", ...(shallow ? ["--depth=1"] : []), "origin", releaseSha);
        git(target, "checkout", "--quiet", "--detach", "FETCH_HEAD");

        expect(() => resolvePreviousReleaseTag({ rootDir: target, fetchOnMiss: false })).toThrow(
          "Could not resolve a previous reachable release tag",
        );
        expect(
          git(target, "for-each-ref", "--format=%(refname)", "refs/tags", "refs/remotes"),
        ).toBe("");
        expect(resolvePreviousReleaseTag({ rootDir: target })).toBe("v2026.5.1");
        expect(git(target, "rev-parse", "HEAD")).toBe(releaseSha);
        expect(git(target, "rev-parse", "--is-shallow-repository")).toBe("false");
        expect(git(target, "rev-list", "--count", "HEAD")).toBe("2");
        expect(
          git(target, "for-each-ref", "--format=%(refname)", "refs/tags", "refs/remotes").split(
            "\n",
          ),
        ).toEqual(["refs/tags/v2026.5.1", "refs/tags/v2026.6.1"]);
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
  );

  it.each([
    { status: "checked", mappedPackageVersions: 101, checkedRepositories: 2, issues: [] },
    {
      status: "partial",
      mappedPackageVersions: 100,
      checkedRepositories: 1,
      issues: [
        { subject: "unmapped-package@1.0.0", reason: "Unsupported repository URL" },
        { subject: "example/tool", reason: "GitHub API rate limit exceeded" },
      ],
    },
  ])(
    "collects report counts and renders $status upstream coverage in both summaries",
    async (upstream) => {
      const dir = await mkdtemp(path.join(tmpdir(), "openclaw-release-dependency-evidence-test-"));
      try {
        const coverage = {
          npm: "checked",
          upstream: {
            source: "github-public-repository-advisories",
            packageVersions: 101,
            repositories: 2,
            ...upstream,
          },
        };
        const findings = [
          { id: "GHSA-blocker", lockfile: "pnpm-lock.yaml", source: "npm-bulk" },
          {
            id: "GHSA-blocker",
            lockfile: ".github/release/vercel-cli/package-lock.json",
            source: "github-repository",
            matchedVersions: ["1.0.0", "1.1.0"],
          },
          {
            id: "GHSA-report",
            lockfile: ".github/release/clawhub-cli/package-lock.json",
            source: "github-repository",
            matchedVersions: ["2.0.0"],
          },
        ];
        await writeJson(dir, "dependency-vulnerability-gate.json", {
          blockers: findings.slice(0, 2),
          findings,
          coverage,
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
          vulnerabilityBlockers: 2,
          vulnerabilityFindings: 3,
          vulnerabilityCoverage: coverage,
          upstreamOnlyVulnerabilityFindings: 2,
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
        for (const rendered of [summary, stepSummary]) {
          expect(rendered).toContain("- npm advisory coverage: checked");
          expect(rendered).toContain(
            `- Upstream public repository advisory coverage: ${upstream.status}`,
          );
          expect(rendered).toContain("- Upstream source: `github-public-repository-advisories`");
          expect(rendered).toContain(
            `- Upstream package versions mapped: ${upstream.mappedPackageVersions}/101`,
          );
          expect(rendered).toContain(
            `- Upstream repositories checked: ${upstream.checkedRepositories}/2`,
          );
          expect(rendered).toContain("- Advisory vulnerability hard blockers: 2");
          expect(rendered).toContain("- Advisory vulnerability total findings: 3");
          expect(rendered).toContain("- Upstream-only vulnerability findings: 2");
          expect(rendered).toContain(`- Upstream coverage issues: ${upstream.issues.length}`);
          for (const { subject, reason } of upstream.issues) {
            expect(rendered).toContain(`  - ${subject}: ${reason}`);
          }
          expect(rendered).toContain(
            "Coverage is limited to these advisory sources; zero findings do not prove that dependencies are unaffected.",
          );
        }
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
  );
});
