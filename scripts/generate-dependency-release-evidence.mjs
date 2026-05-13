#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const DEPENDENCY_EVIDENCE_REPORTS = [
  {
    name: "npm advisory vulnerability gate",
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

function trimOutput(output) {
  return String(output).trim();
}

function commandOutput(
  command,
  args,
  { rootDir, execFileSyncImpl = execFileSync, allowFailure = false },
) {
  try {
    return trimOutput(
      execFileSyncImpl(command, args, {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch (error) {
    if (allowFailure) {
      return null;
    }
    throw error;
  }
}

function runCommand(command, args, { rootDir, execFileSyncImpl = execFileSync }) {
  execFileSyncImpl(command, args, {
    cwd: rootDir,
    stdio: "inherit",
  });
}

export function resolveReleaseTag({ releaseRef, packageVersion }) {
  if (/^[0-9a-fA-F]{40}$/u.test(releaseRef)) {
    return `v${packageVersion}`;
  }
  return releaseRef;
}

export function resolvePreviousReleaseTag({
  rootDir = process.cwd(),
  execFileSyncImpl = execFileSync,
  fetchOnMiss = true,
} = {}) {
  const describeArgs = [
    "describe",
    "--tags",
    "--match",
    RELEASE_TAG_PATTERN,
    "--abbrev=0",
    "HEAD^",
  ];
  const localTag = commandOutput("git", describeArgs, {
    rootDir,
    execFileSyncImpl,
    allowFailure: true,
  });
  if (localTag) {
    return localTag;
  }
  if (fetchOnMiss) {
    runCommand("git", ["fetch", "--tags", "--force", "origin"], { rootDir, execFileSyncImpl });
  }
  const fetchedTag = commandOutput("git", describeArgs, {
    rootDir,
    execFileSyncImpl,
    allowFailure: true,
  });
  if (fetchedTag) {
    return fetchedTag;
  }
  throw new Error(
    "Could not resolve a previous reachable release tag for dependency change evidence.",
  );
}

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
} = {}) {
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

function reportPath(evidenceDir, fileName) {
  return path.join(evidenceDir, fileName);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function collectDependencyEvidenceSummaryCounts(evidenceDir) {
  const [vulnerability, transitiveRisk, ownershipSurface, dependencyChanges] = await Promise.all([
    readJson(reportPath(evidenceDir, "dependency-vulnerability-gate.json")),
    readJson(reportPath(evidenceDir, "transitive-manifest-risk-report.json")),
    readJson(reportPath(evidenceDir, "dependency-ownership-surface-report.json")),
    readJson(reportPath(evidenceDir, "dependency-changes-report.json")),
  ]);
  return {
    vulnerabilityBlockers: vulnerability.blockers.length,
    vulnerabilityFindings: vulnerability.findings.length,
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

export function renderDependencyEvidenceSummary({ releaseTag, releaseSha, baseRef, counts }) {
  return `${[
    "# Dependency release evidence",
    "",
    `Generated for \`${releaseTag}\` at \`${releaseSha}\`.`,
    "",
    "## Summary",
    "",
    `- npm advisory vulnerability hard blockers: ${counts.vulnerabilityBlockers}`,
    `- npm advisory vulnerability total findings: ${counts.vulnerabilityFindings}`,
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

export function renderDependencyEvidenceStepSummary({ evidenceArtifactName, baseRef, counts }) {
  return `${[
    "### Dependency release evidence",
    "",
    `- Evidence artifact: \`${evidenceArtifactName}\``,
    `- Dependency change baseline: \`${baseRef}\``,
    `- npm advisory vulnerability hard blockers: \`${counts.vulnerabilityBlockers}\``,
    `- Transitive manifest reported risk signals: \`${counts.transitiveRiskSignals}\``,
    `- Workspace-policy excluded transitive signals: \`${counts.workspaceExcludedTransitiveSignals}\``,
    `- Ownership/install surface lockfile packages: \`${counts.ownershipLockfilePackages}\``,
    `- Dependency file changes: \`${counts.dependencyFileChanges}\``,
    `- Resolved package changes: \`+${counts.dependencyAddedPackages} -${counts.dependencyRemovedPackages} changed ${counts.dependencyChangedPackages}\``,
  ].join("\n")}\n`;
}

function runEvidenceReports({ rootDir, outputDir, baseRef, execFileSyncImpl }) {
  runCommand(
    "pnpm",
    [
      "deps:vuln:gate",
      "--",
      "--json",
      reportPath(outputDir, "dependency-vulnerability-gate.json"),
      "--markdown",
      reportPath(outputDir, "dependency-vulnerability-gate.md"),
    ],
    { rootDir, execFileSyncImpl },
  );
  runCommand(
    "pnpm",
    [
      "deps:transitive-risk:report",
      "--",
      "--json",
      reportPath(outputDir, "transitive-manifest-risk-report.json"),
      "--markdown",
      reportPath(outputDir, "transitive-manifest-risk-report.md"),
    ],
    { rootDir, execFileSyncImpl },
  );
  runCommand(
    "pnpm",
    [
      "deps:ownership-surface:report",
      "--",
      "--json",
      reportPath(outputDir, "dependency-ownership-surface-report.json"),
      "--markdown",
      reportPath(outputDir, "dependency-ownership-surface-report.md"),
    ],
    { rootDir, execFileSyncImpl },
  );
  runCommand(
    "pnpm",
    [
      "deps:changes:report",
      "--",
      "--base-ref",
      baseRef,
      "--json",
      reportPath(outputDir, "dependency-changes-report.json"),
      "--markdown",
      reportPath(outputDir, "dependency-changes-report.md"),
    ],
    { rootDir, execFileSyncImpl },
  );
}

export async function generateDependencyReleaseEvidence({
  rootDir = process.cwd(),
  outputDir,
  releaseRef,
  npmDistTag,
  baseRef = null,
  githubOutput = process.env.GITHUB_OUTPUT,
  githubStepSummary = process.env.GITHUB_STEP_SUMMARY,
  workflowRunId = process.env.GITHUB_RUN_ID ?? "",
  workflowRunAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "",
  execFileSyncImpl = execFileSync,
  now = new Date(),
} = {}) {
  if (!outputDir) {
    throw new Error("Expected --output-dir <path>.");
  }
  if (!releaseRef) {
    throw new Error("Expected --release-ref <tag-or-sha>.");
  }
  if (!npmDistTag) {
    throw new Error("Expected --npm-dist-tag <tag>.");
  }

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const releaseSha = commandOutput("git", ["rev-parse", "HEAD"], { rootDir, execFileSyncImpl });
  const packageJson = await readJson(path.join(rootDir, "package.json"));
  const packageVersion = packageJson.version;
  const releaseTag = resolveReleaseTag({ releaseRef, packageVersion });
  const dependencyChangeBaseRef =
    baseRef ?? resolvePreviousReleaseTag({ rootDir, execFileSyncImpl });

  runEvidenceReports({
    rootDir,
    outputDir,
    baseRef: dependencyChangeBaseRef,
    execFileSyncImpl,
  });

  const manifest = createDependencyEvidenceManifest({
    generatedAt: now.toISOString(),
    releaseTag,
    releaseRef,
    releaseSha,
    npmDistTag,
    packageVersion,
    workflowRunId,
    workflowRunAttempt,
    dependencyChangeBaseRef,
  });
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
    }),
    "utf8",
  );

  if (githubStepSummary) {
    await appendFile(
      githubStepSummary,
      renderDependencyEvidenceStepSummary({
        evidenceArtifactName: `openclaw-release-dependency-evidence-${releaseRef}`,
        baseRef: dependencyChangeBaseRef,
        counts,
      }),
      "utf8",
    );
  }
  if (githubOutput) {
    await appendFile(githubOutput, `dir=${outputDir}\n`, "utf8");
  }

  return { manifest, counts, outputDir };
}

function parseArgs(argv) {
  const options = {
    rootDir: process.cwd(),
    outputDir: null,
    releaseRef: null,
    npmDistTag: null,
    baseRef: null,
    githubOutput: process.env.GITHUB_OUTPUT,
    githubStepSummary: process.env.GITHUB_STEP_SUMMARY,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--root") {
      options.rootDir = argv[++index];
      continue;
    }
    if (arg === "--output-dir") {
      options.outputDir = argv[++index];
      continue;
    }
    if (arg === "--release-ref") {
      options.releaseRef = argv[++index];
      continue;
    }
    if (arg === "--npm-dist-tag") {
      options.npmDistTag = argv[++index];
      continue;
    }
    if (arg === "--base-ref") {
      options.baseRef = argv[++index];
      continue;
    }
    if (arg === "--github-output") {
      options.githubOutput = argv[++index];
      continue;
    }
    if (arg === "--github-step-summary") {
      options.githubStepSummary = argv[++index];
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  await generateDependencyReleaseEvidence(parseArgs(argv));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(`${error.stack ?? error.message ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
