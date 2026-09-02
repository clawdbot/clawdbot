#!/usr/bin/env node

// Generates release dependency evidence artifacts and summaries.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { runDependencyVulnerabilityGate } from "./dependency-vulnerability-gate.mts";
import { parseFlagArgs, stringFlag } from "./lib/arg-utils.mts";
import {
  RELEASE_DEPENDENCY_RISK_LOCKFILES,
  resolveReleaseDependencyRiskAcceptance,
} from "./lib/release-dependency-risk-acceptance.mts";

/**
 * Dependency evidence reports generated for release artifacts.
 */
export const DEPENDENCY_EVIDENCE_REPORTS = [
  {
    name: "Dependency advisory vulnerability gate",
    command: "pnpm deps:vuln:gate",
    policy: "hard-blocking",
    json: "dependency-vulnerability-gate.json",
    markdown: "dependency-vulnerability-gate.md",
  },
  {
    name: "Transitive manifest risk report",
    command: "pnpm deps:transitive-risk:report",
    policy: "report-only",
    json: "transitive-manifest-risk-report.json",
    markdown: "transitive-manifest-risk-report.md",
  },
  {
    name: "Dependency ownership and install surface report",
    command: "pnpm deps:ownership-surface:report",
    policy: "report-only",
    json: "dependency-ownership-surface-report.json",
    markdown: "dependency-ownership-surface-report.md",
  },
  {
    name: "Dependency change report",
    command: "pnpm deps:changes:report",
    policy: "report-only",
    json: "dependency-changes-report.json",
    markdown: "dependency-changes-report.md",
  },
];

const RELEASE_TAG_PATTERN = "v[0-9]*.[0-9]*.[0-9]*";

type ExecFileSyncLike = (command: string, args?: string[], options?: object) => unknown;
type ManifestParams = {
  dependencyChangeBaseRef?: string;
  generatedAt?: string;
  npmDistTag?: string;
  packageVersion?: string;
  releaseRef?: string;
  releaseSha?: string;
  releaseTag?: string;
  workflowRunAttempt?: string;
  workflowRunId?: string;
};
type GenerateEvidenceParams = Partial<EvidenceCliOptions> & {
  execFileSyncImpl?: ExecFileSyncLike;
  now?: Date;
  workflowRunAttempt?: string;
  workflowRunId?: string;
};
type EvidenceCliOptions = {
  baseRef: string | null;
  githubOutput: string | undefined;
  githubStepSummary: string | undefined;
  help?: true;
  npmDistTag: string | null;
  outputDir: string | null;
  releaseRef: string | null;
  rootDir: string;
};

function commandOutput(
  command: string,
  args: string[],
  rootDir: string,
  execFileSyncImpl: ExecFileSyncLike = execFileSync,
  allowFailure = false,
): string | null {
  try {
    return String(
      execFileSyncImpl(command, args, {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).trim();
  } catch (error) {
    if (allowFailure) {
      return null;
    }
    throw error;
  }
}

function runCommand(
  command: string,
  args: string[],
  rootDir: string,
  execFileSyncImpl: ExecFileSyncLike = execFileSync,
) {
  execFileSyncImpl(command, args, {
    cwd: rootDir,
    stdio: "inherit",
  });
}

/**
 * Resolves the release tag when the release ref is a SHA or tag.
 */
export function resolveReleaseTag({
  releaseRef,
  packageVersion,
}: Required<Pick<ManifestParams, "packageVersion" | "releaseRef">>) {
  if (/^[0-9a-fA-F]{40}$/u.test(releaseRef)) {
    return `v${packageVersion}`;
  }
  return releaseRef;
}

/**
 * Resolves the previous reachable release tag for dependency diffs.
 */
export function resolvePreviousReleaseTag({
  rootDir = process.cwd(),
  execFileSyncImpl = execFileSync,
  fetchOnMiss = true,
}: { rootDir?: string; execFileSyncImpl?: ExecFileSyncLike; fetchOnMiss?: boolean } = {}) {
  const describeArgs = [
    "describe",
    "--tags",
    "--match",
    RELEASE_TAG_PATTERN,
    "--abbrev=0",
    "HEAD^",
  ];
  const localTag = commandOutput("git", describeArgs, rootDir, execFileSyncImpl, true);
  if (localTag) {
    return localTag;
  }
  if (fetchOnMiss) {
    const releaseSha = commandOutput("git", ["rev-parse", "HEAD"], rootDir, execFileSyncImpl);
    if (!releaseSha) {
      throw new Error("Could not resolve the release commit SHA.");
    }
    const shallow = commandOutput(
      "git",
      ["rev-parse", "--is-shallow-repository"],
      rootDir,
      execFileSyncImpl,
    );
    // Describe needs complete target ancestry; unrelated branches and tooling tags do not.
    runCommand(
      "git",
      [
        "fetch",
        "--filter=blob:none",
        "--no-tags",
        "--force",
        ...(shallow === "true" ? ["--unshallow"] : []),
        "origin",
        releaseSha,
        "+refs/tags/v*:refs/tags/v*",
      ],
      rootDir,
      execFileSyncImpl,
    );
  }
  const fetchedTag = commandOutput("git", describeArgs, rootDir, execFileSyncImpl, true);
  if (fetchedTag) {
    return fetchedTag;
  }
  throw new Error(
    "Could not resolve a previous reachable release tag for dependency change evidence.",
  );
}

/**
 * Creates the dependency evidence manifest payload.
 */
export function createDependencyEvidenceManifest({
  generatedAt = new Date().toISOString(),
  releaseTag,
  releaseRef,
  releaseSha,
  npmDistTag,
  packageVersion,
  workflowRunId = "",
  workflowRunAttempt = "",
  dependencyChangeBaseRef,
}: ManifestParams = {}) {
  return {
    schemaVersion: 1,
    generatedAt,
    releaseTag,
    releaseRef,
    releaseSha,
    npmDistTag,
    packageName: "openclaw",
    packageVersion,
    workflowRunId,
    workflowRunAttempt,
    dependencyChangeBaseRef,
    reports: DEPENDENCY_EVIDENCE_REPORTS,
  };
}

function reportPath(evidenceDir: string, fileName: string) {
  return path.join(evidenceDir, fileName);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

/**
 * Reads generated reports and collects summary counts.
 */
export async function collectDependencyEvidenceSummaryCounts(evidenceDir: string) {
  const [vulnerability, transitiveRisk, ownershipSurface, dependencyChanges] = await Promise.all([
    readJson<Awaited<ReturnType<typeof runDependencyVulnerabilityGate>>>(
      reportPath(evidenceDir, "dependency-vulnerability-gate.json"),
    ),
    readJson<{
      findingCount: number;
      metadataFailures: unknown[];
      workspaceExcludedFindingCount: number;
    }>(reportPath(evidenceDir, "transitive-manifest-risk-report.json")),
    readJson<{ summary: { buildRiskPackageCount: number; lockfilePackageCount: number } }>(
      reportPath(evidenceDir, "dependency-ownership-surface-report.json"),
    ),
    readJson<{
      summary: {
        addedPackages: number;
        changedPackages: number;
        dependencyFileChanges: number;
        removedPackages: number;
      };
    }>(reportPath(evidenceDir, "dependency-changes-report.json")),
  ]);
  return {
    vulnerabilityBlockers: vulnerability.blockers.length,
    vulnerabilityFindings: vulnerability.findings.length,
    vulnerabilityCoverage: vulnerability.coverage,
    upstreamOnlyVulnerabilityFindings: vulnerability.findings.filter(
      (finding) => finding.source === "github-repository",
    ).length,
    transitiveRiskSignals: transitiveRisk.findingCount,
    workspaceExcludedTransitiveSignals: transitiveRisk.workspaceExcludedFindingCount,
    transitiveMetadataFailures: transitiveRisk.metadataFailures.length,
    ownershipLockfilePackages: ownershipSurface.summary.lockfilePackageCount,
    ownershipBuildRiskPackages: ownershipSurface.summary.buildRiskPackageCount,
    dependencyFileChanges: dependencyChanges.summary.dependencyFileChanges,
    dependencyAddedPackages: dependencyChanges.summary.addedPackages,
    dependencyRemovedPackages: dependencyChanges.summary.removedPackages,
    dependencyChangedPackages: dependencyChanges.summary.changedPackages,
  };
}

type EvidenceSummaryCounts = Awaited<ReturnType<typeof collectDependencyEvidenceSummaryCounts>>;
type EvidenceSummaryParams = { baseRef: string; counts: EvidenceSummaryCounts };

function renderVulnerabilityEvidenceSummary(counts: EvidenceSummaryCounts) {
  const { npm, upstream } = counts.vulnerabilityCoverage;
  return [
    `- npm advisory coverage: ${npm}`,
    `- Upstream public repository advisory coverage: ${upstream.status}`,
    `- Upstream source: \`${upstream.source}\``,
    `- Upstream package versions mapped: ${upstream.mappedPackageVersions}/${upstream.packageVersions}`,
    `- Upstream repositories checked: ${upstream.checkedRepositories}/${upstream.repositories}`,
    `- Advisory vulnerability hard blockers: ${counts.vulnerabilityBlockers}`,
    `- Advisory vulnerability total findings: ${counts.vulnerabilityFindings}`,
    `- Upstream-only vulnerability findings: ${counts.upstreamOnlyVulnerabilityFindings}`,
    `- Upstream coverage issues: ${upstream.issues.length}`,
    ...upstream.issues.slice(0, 25).map(({ subject, reason }) => `  - ${subject}: ${reason}`),
    ...(upstream.issues.length > 25
      ? [
          `  - ${upstream.issues.length - 25} more coverage issues; see dependency-vulnerability-gate.json.`,
        ]
      : []),
    "",
    "Coverage is limited to these advisory sources; zero findings do not prove that dependencies are unaffected.",
    "",
  ];
}

/**
 * Renders the dependency evidence Markdown summary.
 */
export function renderDependencyEvidenceSummary({
  releaseTag,
  releaseSha,
  baseRef,
  counts,
}: EvidenceSummaryParams & Required<Pick<ManifestParams, "releaseSha" | "releaseTag">>) {
  return `${[
    "# Dependency release evidence",
    "",
    `Generated for \`${releaseTag}\` at \`${releaseSha}\`.`,
    "",
    "## Summary",
    "",
    ...renderVulnerabilityEvidenceSummary(counts),
    `- Transitive manifest reported risk signals: ${counts.transitiveRiskSignals}`,
    `- Workspace-policy excluded transitive signals: ${counts.workspaceExcludedTransitiveSignals}`,
    `- Transitive manifest metadata failures: ${counts.transitiveMetadataFailures}`,
    `- Lockfile packages inspected for ownership/install surface: ${counts.ownershipLockfilePackages}`,
    `- Packages with install-time or platform-specific behavior: ${counts.ownershipBuildRiskPackages}`,
    `- Dependency change baseline: \`${baseRef}\``,
    `- Dependency file changes: ${counts.dependencyFileChanges}`,
    `- Resolved package changes: +${counts.dependencyAddedPackages} -${counts.dependencyRemovedPackages} changed ${counts.dependencyChangedPackages}`,
    "",
    "## Reports",
    "",
    "- `dependency-vulnerability-gate.md`",
    "- `transitive-manifest-risk-report.md`",
    "- `dependency-ownership-surface-report.md`",
    "- `dependency-changes-report.md`",
  ].join("\n")}\n`;
}

/**
 * Renders the GitHub Actions step summary for dependency evidence.
 */
export function renderDependencyEvidenceStepSummary({
  evidenceArtifactName,
  baseRef,
  counts,
}: EvidenceSummaryParams & { evidenceArtifactName: string }) {
  return `${[
    "### Dependency release evidence",
    "",
    `- Evidence artifact: \`${evidenceArtifactName}\``,
    `- Dependency change baseline: \`${baseRef}\``,
    ...renderVulnerabilityEvidenceSummary(counts),
    `- Transitive manifest reported risk signals: \`${counts.transitiveRiskSignals}\``,
    `- Workspace-policy excluded transitive signals: \`${counts.workspaceExcludedTransitiveSignals}\``,
    `- Ownership/install surface lockfile packages: \`${counts.ownershipLockfilePackages}\``,
    `- Dependency file changes: \`${counts.dependencyFileChanges}\``,
    `- Resolved package changes: \`+${counts.dependencyAddedPackages} -${counts.dependencyRemovedPackages} changed ${counts.dependencyChangedPackages}\``,
  ].join("\n")}\n`;
}

async function runEvidenceReports(
  rootDir: string,
  outputDir: string,
  baseRef: string,
  execFileSyncImpl: ExecFileSyncLike,
  packageVersion: string,
) {
  let riskAcceptance: ReturnType<typeof resolveReleaseDependencyRiskAcceptance> = null;
  const toolingRoot = path.resolve(import.meta.dirname, "..");
  // Report implementations belong to this tooling checkout; --root selects only the source data.
  // Release branches can keep frozen product bytes while trusted release tooling is repaired.
  for (const report of DEPENDENCY_EVIDENCE_REPORTS) {
    try {
      runCommand(
        "pnpm",
        [
          report.command.slice("pnpm ".length),
          "--",
          "--root",
          rootDir,
          ...(report.json === "dependency-changes-report.json" ? ["--base-ref", baseRef] : []),
          "--json",
          reportPath(outputDir, report.json),
          "--markdown",
          reportPath(outputDir, report.markdown),
        ],
        toolingRoot,
        execFileSyncImpl,
      );
    } catch (error) {
      if (
        report.json !== "dependency-vulnerability-gate.json" ||
        !(error instanceof Error) ||
        !("status" in error) ||
        error.status !== 1 ||
        packageVersion !== "2026.9.1"
      ) {
        throw error;
      }
      const vulnerability = await readJson<
        Awaited<ReturnType<typeof runDependencyVulnerabilityGate>>
      >(reportPath(outputDir, report.json));
      const lockfileSha256 = Object.fromEntries(
        await Promise.all(
          Object.keys(RELEASE_DEPENDENCY_RISK_LOCKFILES).map(async (file) => [
            file,
            createHash("sha256")
              .update(await readFile(path.join(rootDir, file)))
              .digest("hex"),
          ]),
        ),
      );
      riskAcceptance = resolveReleaseDependencyRiskAcceptance({
        packageVersion,
        lockfileSha256,
        blockers: vulnerability.blockers,
      });
      if (!riskAcceptance) {
        throw error;
      }
      console.warn(
        "WARNING: 2026.9.1 dependency risks accepted by maintainer; scan findings remain unresolved.",
      );
    }
  }
  return riskAcceptance;
}

/**
 * Generates dependency evidence reports, manifest, and summaries for a release.
 */
async function generateDependencyReleaseEvidence({
  rootDir: sourceRoot = process.cwd(),
  outputDir: requestedOutputDir,
  releaseRef,
  npmDistTag,
  baseRef = null,
  githubOutput = process.env.GITHUB_OUTPUT,
  githubStepSummary = process.env.GITHUB_STEP_SUMMARY,
  workflowRunId = process.env.GITHUB_RUN_ID ?? "",
  workflowRunAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "",
  execFileSyncImpl = execFileSync,
  now = new Date(),
}: GenerateEvidenceParams = {}) {
  if (!requestedOutputDir) {
    throw new Error("Expected --output-dir <path>.");
  }
  if (!releaseRef) {
    throw new Error("Expected --release-ref <tag-or-sha>.");
  }
  if (!npmDistTag) {
    throw new Error("Expected --npm-dist-tag <tag>.");
  }

  const rootDir = path.resolve(sourceRoot);
  const outputDir = path.resolve(requestedOutputDir);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  // Publish the artifact location before a blocking report exits so CI can retain its evidence.
  if (githubOutput) {
    await appendFile(githubOutput, `dir=${outputDir}\n`, "utf8");
  }

  const releaseSha = commandOutput("git", ["rev-parse", "HEAD"], rootDir, execFileSyncImpl);
  if (!releaseSha) {
    throw new Error("Could not resolve the release commit SHA.");
  }
  const packageJson = await readJson<{ version: string }>(path.join(rootDir, "package.json"));
  const packageVersion = packageJson.version;
  const releaseTag = resolveReleaseTag({ releaseRef, packageVersion });
  const dependencyChangeBaseRef =
    baseRef ?? resolvePreviousReleaseTag({ rootDir, execFileSyncImpl });

  const riskAcceptance = await runEvidenceReports(
    rootDir,
    outputDir,
    dependencyChangeBaseRef,
    execFileSyncImpl,
    packageVersion,
  );

  const manifest = {
    ...createDependencyEvidenceManifest({
      generatedAt: now.toISOString(),
      releaseTag,
      releaseRef,
      releaseSha,
      npmDistTag,
      packageVersion,
      workflowRunId,
      workflowRunAttempt,
      dependencyChangeBaseRef,
    }),
    ...(riskAcceptance ? { riskAcceptance } : {}),
  };
  await writeFile(
    reportPath(outputDir, "dependency-evidence-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  const counts = await collectDependencyEvidenceSummaryCounts(outputDir);
  await writeFile(
    reportPath(outputDir, "dependency-evidence-summary.md"),
    renderDependencyEvidenceSummary({
      releaseTag,
      releaseSha,
      baseRef: dependencyChangeBaseRef,
      counts,
    }) +
      (riskAcceptance
        ? "\n## Operator-accepted dependency risk\n\nThe maintainer accepted the five recorded advisory blockers for 2026.9.1 with unchanged dependencies. They remain unresolved, not a clean security scan. Exact graph hashes and findings are retained in dependency-evidence-manifest.json.\n"
        : ""),
    "utf8",
  );

  if (githubStepSummary) {
    await appendFile(
      githubStepSummary,
      renderDependencyEvidenceStepSummary({
        evidenceArtifactName: `openclaw-release-dependency-evidence-${releaseRef}`,
        baseRef: dependencyChangeBaseRef,
        counts,
      }) +
        (riskAcceptance
          ? "\nWARNING: Five dependency advisory blockers remain unresolved and were explicitly accepted for 2026.9.1. See the dependency evidence manifest.\n"
          : ""),
      "utf8",
    );
  }
  return { manifest, counts, outputDir };
}

function usage() {
  return `Usage: node --import tsx scripts/generate-dependency-release-evidence.mts --output-dir <dir> --release-ref <ref> --npm-dist-tag <tag> [options]

Generates release dependency evidence reports and summary artifacts.

Options:
  --root <dir>                  Repository root
  --output-dir <dir>            Evidence artifact directory
  --release-ref <ref>           Release tag or SHA under validation
  --npm-dist-tag <tag>          npm dist-tag being validated
  --base-ref <ref>              Dependency change comparison base
  --github-output <path>        GitHub Actions output file
  --github-step-summary <path>  GitHub Actions step summary file
  -h, --help                    Show this help
`;
}

export function parseArgs(argv: string[]): EvidenceCliOptions {
  const options: EvidenceCliOptions = {
    rootDir: process.cwd(),
    outputDir: null,
    releaseRef: null,
    npmDistTag: null,
    baseRef: null,
    githubOutput: process.env.GITHUB_OUTPUT,
    githubStepSummary: process.env.GITHUB_STEP_SUMMARY,
  };
  const helpIndex = argv.findIndex((arg) => arg === "-h" || arg === "--help");
  const specs = [
    ["--root", "rootDir", false],
    ["--output-dir", "outputDir", false],
    ["--release-ref", "releaseRef", false],
    ["--npm-dist-tag", "npmDistTag", false],
    ["--base-ref", "baseRef", false],
    ["--github-output", "githubOutput", true],
    ["--github-step-summary", "githubStepSummary", true],
  ] satisfies Array<readonly [string, keyof EvidenceCliOptions, boolean]>;
  const parsed = parseFlagArgs(
    helpIndex === -1 ? argv : argv.slice(0, helpIndex),
    options,
    specs.map(([flag, key, allowEmpty]) =>
      stringFlag(flag, key, {
        allowEmpty,
        allowInline: false,
        missingValueMessage: `Expected ${flag} <value>.`,
        rejectShortOptions: true,
      }),
    ),
    {
      duplicateOptionMessage: (flag) => `${flag} was provided more than once.`,
      onUnhandledArg(arg) {
        throw new Error(`Unsupported argument: ${arg}`);
      },
    },
  );
  return helpIndex === -1 ? parsed : { ...parsed, help: true };
}

/**
 * Runs the dependency release evidence generator CLI.
 */
async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  await generateDependencyReleaseEvidence(options);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n[dependency-release-evidence] FAILED (exit 1)\n`,
      );
      process.exitCode = 1;
    },
  );
}
