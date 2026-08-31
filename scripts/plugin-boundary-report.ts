#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listPluginCompatRecords } from "../src/plugins/compat/registry.ts";
import type { PluginCompatRecord } from "../src/plugins/compat/types.ts";
import {
  pluginSdkEntrypoints,
  publicPluginOwnedSdkEntrypoints,
  supportedBundledFacadeSdkEntrypoints,
} from "./lib/plugin-sdk-entries.mts";

const REPO_ROOT = process.cwd();
const SOURCE_ROOTS = ["src", "extensions", "packages", "scripts", "test", "docs"] as const;
const SKIPPED_DIRS = new Set([
  ".artifacts",
  ".git",
  "coverage",
  "dist",
  "dist-runtime",
  "node_modules",
]);
const TEXT_FILE_PATTERN = /\.(?:[cm]?[jt]sx?|json|mdx?|ya?ml)$/u;
const MEMORY_HOST_SOURCE_BRIDGE_TOKEN = "src/memory-host-sdk/";
const MEMORY_HOST_CORE_REFERENCE_TOKEN = "../../../src/";
type CliOptions = {
  json: boolean;
  summary: boolean;
  owner?: string;
  failOnEligibleCompat: boolean;
  help: boolean;
};

type CompatDebtRecord = {
  code: string;
  owner: string;
  status: PluginCompatRecord["status"];
  removeAfter?: string;
  removalGate?: PluginCompatRecord["removalGate"];
  replacement: string;
  docsPath: string;
  surfaces: readonly string[];
  tokens: string[];
  codeReferenceFiles: string[];
  docReferenceFiles: string[];
  eligibleForRemoval: boolean;
};

type RemovalPendingDebtRecord = {
  code: string;
  owner: string;
  status: "removal-pending";
  removeAfter?: string;
  removalGate?: PluginCompatRecord["removalGate"];
  blocker: string;
  readerFiles: string[];
  dueForReview: boolean;
};

type RemovalPendingDebtSummary = Omit<RemovalPendingDebtRecord, "readerFiles"> & {
  readerCount: number;
  readerSample: string[];
};

type WorkspaceTextFile = {
  file: string;
  relativeFile: string;
  source: string;
};

type BoundaryReport = {
  generatedAt: string;
  compat: {
    deprecatedCount: number;
    eligibleForRemovalCount: number;
    records: CompatDebtRecord[];
    removalPendingCount: number;
    removalPendingDueCount: number;
    removalPending: RemovalPendingDebtRecord[];
  };
  pluginSdk: {
    entrypointCount: number;
    supportedBundledFacadeCount: number;
    publicPluginOwnedCount: number;
  };
  memoryHostSdk: {
    privatePackage: boolean;
    exportedSubpaths: string[];
    sourceBridgeFiles: string[];
    packageCoreReferenceFiles: string[];
  };
};

type BoundaryReportSummary = {
  generatedAt: string;
  owner?: string;
  compat: {
    deprecatedCount: number;
    eligibleForRemovalCount: number;
    deprecatedByOwner: Record<string, number>;
    eligibleForRemoval: Array<Pick<CompatDebtRecord, "code" | "owner" | "removeAfter">>;
    removalPendingCount: number;
    removalPendingDueCount: number;
    removalPending: RemovalPendingDebtSummary[];
  };
  pluginSdk: {
    entrypointCount: number;
    supportedBundledFacadeCount: number;
    publicPluginOwnedCount: number;
  };
  memoryHostSdk: {
    privatePackage: boolean;
    exportedSubpathCount: number;
    sourceBridgeFileCount: number;
    packageCoreReferenceFileCount: number;
    implementation:
      | "private-core-bridge"
      | "private-package-core-integrated"
      | "package-owned"
      | "mixed";
  };
};

export type PluginBoundaryReportResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function collectTextFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) {
    return files;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) {
      continue;
    }
    const nextPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTextFiles(nextPath));
      continue;
    }
    if (entry.isFile() && TEXT_FILE_PATTERN.test(entry.name)) {
      files.push(nextPath);
    }
  }
  return files;
}

function isExistingTextFile(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function collectWorkspaceTextFiles(): string[] {
  const gitFiles = collectWorkspaceTextFilesFromGit();
  return (
    gitFiles ?? SOURCE_ROOTS.flatMap((root) => collectTextFiles(resolve(REPO_ROOT, root)))
  ).toSorted((left, right) => relative(REPO_ROOT, left).localeCompare(relative(REPO_ROOT, right)));
}

function collectWorkspaceTextFilesFromGit(): string[] | null {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SOURCE_ROOTS],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && TEXT_FILE_PATTERN.test(line))
    .filter((line) => !line.split("/").some((part) => SKIPPED_DIRS.has(part)))
    .map((line) => resolve(REPO_ROOT, line))
    .filter(isExistingTextFile);
}

function collectWorkspaceTextFilesMatchingGit(patternArgs: readonly string[]): string[] | null {
  const result = spawnSync(
    "git",
    ["grep", "--untracked", "-l", ...patternArgs, "--", ...SOURCE_ROOTS],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && TEXT_FILE_PATTERN.test(line))
    .filter((line) => !line.split("/").some((part) => SKIPPED_DIRS.has(part)))
    .map((line) => resolve(REPO_ROOT, line))
    .filter(isExistingTextFile);
}

function repoRelative(file: string): string {
  return relative(REPO_ROOT, file).replaceAll("\\", "/");
}

function collectWorkspaceTextFileSources(
  records?: readonly PluginCompatRecord[],
): WorkspaceTextFile[] {
  const tokens = records?.flatMap((record) =>
    record.status === "deprecated"
      ? extractCompatTokens(record)
      : record.status === "removal-pending"
        ? extractCompatSurfaceTokens(record)
        : [],
  );
  // Keep every file either collector can use; Git failure retains the exhaustive scan.
  const matches = tokens
    ? collectWorkspaceTextFilesMatchingGit([
        "-F",
        ...[...tokens, MEMORY_HOST_SOURCE_BRIDGE_TOKEN, MEMORY_HOST_CORE_REFERENCE_TOKEN].flatMap(
          (token) => ["-e", token],
        ),
      ])
    : null;
  return (matches ?? collectWorkspaceTextFiles()).map((file) => ({
    file,
    relativeFile: repoRelative(file),
    source: readFileSync(file, "utf8"),
  }));
}

function collectSummaryWorkspaceTextFileSources(): WorkspaceTextFile[] {
  const pluginSdkFiles = collectWorkspaceTextFilesMatchingGit([
    "-E",
    String.raw`openclaw/plugin-sdk/[a-z0-9][a-z0-9-]*`,
  ]);
  if (!pluginSdkFiles) {
    return collectWorkspaceTextFileSources();
  }
  const files = new Set(pluginSdkFiles);
  for (const file of collectTextFiles(resolve(REPO_ROOT, "packages/memory-host-sdk/src"))) {
    files.add(file);
  }
  return [...files]
    .toSorted((left, right) => repoRelative(left).localeCompare(repoRelative(right)))
    .map((file) => ({
      file,
      relativeFile: repoRelative(file),
      source: readFileSync(file, "utf8"),
    }));
}

function isDocsFile(file: string): boolean {
  return file.startsWith("docs/") || file === "README.md";
}

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    summary: false,
    failOnEligibleCompat: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--summary") {
      options.summary = true;
    } else if (arg === "--owner") {
      const owner = args[index + 1];
      if (!owner || owner.startsWith("--")) {
        throw new Error("--owner requires a plugin or compatibility owner id");
      }
      options.owner = owner;
      index += 1;
    } else if (arg === "--fail-on-eligible-compat") {
      options.failOnEligibleCompat = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function renderHelp(): string {
  return [
    "Usage: pnpm plugins:boundary-report [--summary] [--json] [--owner <id>] [fail flags]",
    "",
    "Options:",
    "  --summary                              Print compact counts only.",
    "  --json                                 Emit JSON instead of text.",
    "  --owner <id>                           Filter compatibility records by owner id.",
    "  --fail-on-eligible-compat              Exit non-zero when deprecated compat is due for removal.",
  ].join("\n");
}

function extractCompatTokensFromValues(values: readonly (string | undefined)[]): string[] {
  const tokens = new Set<string>();
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    for (const match of value.matchAll(/`([^`]+)`/g)) {
      const token = match[1]?.trim();
      if (token && !token.includes(" ")) {
        tokens.add(token);
      }
    }
    for (const match of value.matchAll(/\bopenclaw\/[a-z0-9/-]+\b/g)) {
      tokens.add(match[0]);
    }
    for (const match of value.matchAll(/\bOPENCLAW_[A-Z0-9_]+\b/g)) {
      tokens.add(match[0]);
    }
    for (const match of value.matchAll(/\b[a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+\b/g)) {
      tokens.add(match[0]);
    }
    for (const match of value.matchAll(/\b[a-z][a-zA-Z0-9_]*_[a-zA-Z0-9_]+\b/g)) {
      tokens.add(match[0]);
    }
  }
  return [...tokens].toSorted();
}

function extractCompatTokens(record: PluginCompatRecord): string[] {
  return extractCompatTokensFromValues([
    record.code,
    record.replacement,
    ...record.surfaces,
    ...record.diagnostics,
  ]);
}

function extractCompatSurfaceTokens(record: PluginCompatRecord): string[] {
  return extractCompatTokensFromValues(record.surfaces);
}

function collectReferenceFiles(files: readonly WorkspaceTextFile[], tokens: readonly string[]) {
  const codeReferenceFiles = new Set<string>();
  const docReferenceFiles = new Set<string>();
  for (const { relativeFile, source } of files) {
    if (relativeFile === "src/plugins/compat/registry.ts") {
      continue;
    }
    if (!tokens.some((token) => source.includes(token))) {
      continue;
    }
    if (isDocsFile(relativeFile)) {
      docReferenceFiles.add(relativeFile);
    } else {
      codeReferenceFiles.add(relativeFile);
    }
  }
  return {
    codeReferenceFiles: [...codeReferenceFiles].toSorted(),
    docReferenceFiles: [...docReferenceFiles].toSorted(),
  };
}

export function isPluginCompatEligibleForRemoval(
  removeAfter: string | undefined,
  today = new Date(),
): boolean {
  if (!removeAfter) {
    return false;
  }
  const firstRemovalInstant = new Date(`${removeAfter}T00:00:00Z`);
  firstRemovalInstant.setUTCDate(firstRemovalInstant.getUTCDate() + 1);
  return firstRemovalInstant <= today;
}

function collectCompatDebt(
  records: readonly PluginCompatRecord[],
  files: readonly WorkspaceTextFile[],
  today = new Date(),
  options: { includeReferenceFiles?: boolean } = {},
): CompatDebtRecord[] {
  return records
    .filter((record) => record.status === "deprecated")
    .map((record) => {
      const tokens = extractCompatTokens(record);
      const references =
        options.includeReferenceFiles === false
          ? { codeReferenceFiles: [], docReferenceFiles: [] }
          : collectReferenceFiles(files, tokens);
      const eligibleForRemoval = isPluginCompatEligibleForRemoval(record.removeAfter, today);
      return {
        code: record.code,
        owner: record.owner,
        status: record.status,
        removeAfter: record.removeAfter,
        removalGate: record.removalGate,
        replacement: record.replacement as string,
        docsPath: record.docsPath,
        surfaces: record.surfaces,
        tokens,
        codeReferenceFiles: references.codeReferenceFiles,
        docReferenceFiles: references.docReferenceFiles,
        eligibleForRemoval,
      };
    })
    .toSorted(
      (left, right) =>
        formatRemovalGate(left).localeCompare(formatRemovalGate(right)) ||
        left.owner.localeCompare(right.owner) ||
        left.code.localeCompare(right.code),
    );
}

function collectRemovalPendingDebt(
  records: readonly PluginCompatRecord[],
  files: readonly WorkspaceTextFile[],
  today = new Date(),
): RemovalPendingDebtRecord[] {
  return records
    .filter((record) => record.status === "removal-pending")
    .map((record) => {
      const references = collectReferenceFiles(files, extractCompatSurfaceTokens(record));
      return {
        code: record.code,
        owner: record.owner,
        status: "removal-pending" as const,
        removeAfter: record.removeAfter,
        removalGate: record.removalGate,
        blocker: record.replacement ?? "no removal blocker documented",
        readerFiles: references.codeReferenceFiles,
        dueForReview: record.removeAfter
          ? new Date(`${record.removeAfter}T00:00:00Z`) <= today
          : false,
      };
    })
    .toSorted(
      (left, right) =>
        formatRemovalGate(left).localeCompare(formatRemovalGate(right)) ||
        left.owner.localeCompare(right.owner) ||
        left.code.localeCompare(right.code),
    );
}

function collectMemoryHostBoundary(
  files: readonly WorkspaceTextFile[],
): BoundaryReport["memoryHostSdk"] {
  const packageJson = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "packages/memory-host-sdk/package.json"), "utf8"),
  ) as { private?: boolean; exports?: Record<string, string> };
  const sourceBridgeFiles: string[] = [];
  const packageCoreReferenceFiles = new Set<string>();
  for (const { relativeFile, source } of files) {
    if (!relativeFile.startsWith("packages/memory-host-sdk/src/")) {
      continue;
    }
    if (source.includes(MEMORY_HOST_SOURCE_BRIDGE_TOKEN)) {
      sourceBridgeFiles.push(relativeFile);
    }
    if (source.includes(MEMORY_HOST_CORE_REFERENCE_TOKEN)) {
      packageCoreReferenceFiles.add(relativeFile);
    }
  }
  return {
    privatePackage: packageJson.private === true,
    exportedSubpaths: Object.keys(packageJson.exports ?? {}).toSorted(),
    sourceBridgeFiles: sourceBridgeFiles.toSorted(),
    packageCoreReferenceFiles: [...packageCoreReferenceFiles].toSorted(),
  };
}

function countByOwner(records: readonly CompatDebtRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.owner] = (counts[record.owner] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function formatRemovalGate(
  record: Pick<PluginCompatRecord, "removeAfter" | "removalGate">,
): string {
  return record.removeAfter ?? record.removalGate ?? "no-date";
}

function resolveMemoryHostImplementation(
  memoryHostSdk: BoundaryReport["memoryHostSdk"],
): BoundaryReportSummary["memoryHostSdk"]["implementation"] {
  if (memoryHostSdk.privatePackage && memoryHostSdk.sourceBridgeFiles.length > 0) {
    return "private-core-bridge";
  }
  if (memoryHostSdk.privatePackage && memoryHostSdk.packageCoreReferenceFiles.length > 0) {
    return "private-package-core-integrated";
  }
  if (memoryHostSdk.packageCoreReferenceFiles.length === 0) {
    return "package-owned";
  }
  return "mixed";
}

function buildSummary(report: BoundaryReport, owner?: string): BoundaryReportSummary {
  const eligibleForRemoval = report.compat.records
    .filter((record) => record.eligibleForRemoval)
    .map((record) => ({
      code: record.code,
      owner: record.owner,
      removeAfter: record.removeAfter,
    }));
  return {
    generatedAt: report.generatedAt,
    owner,
    compat: {
      deprecatedCount: report.compat.deprecatedCount,
      eligibleForRemovalCount: report.compat.eligibleForRemovalCount,
      deprecatedByOwner: countByOwner(report.compat.records),
      eligibleForRemoval,
      removalPendingCount: report.compat.removalPendingCount,
      removalPendingDueCount: report.compat.removalPendingDueCount,
      removalPending: report.compat.removalPending.map(({ readerFiles, ...record }) => ({
        ...record,
        readerCount: readerFiles.length,
        readerSample: readerFiles.slice(0, 5),
      })),
    },
    pluginSdk: {
      entrypointCount: report.pluginSdk.entrypointCount,
      supportedBundledFacadeCount: report.pluginSdk.supportedBundledFacadeCount,
      publicPluginOwnedCount: report.pluginSdk.publicPluginOwnedCount,
    },
    memoryHostSdk: {
      privatePackage: report.memoryHostSdk.privatePackage,
      exportedSubpathCount: report.memoryHostSdk.exportedSubpaths.length,
      sourceBridgeFileCount: report.memoryHostSdk.sourceBridgeFiles.length,
      packageCoreReferenceFileCount: report.memoryHostSdk.packageCoreReferenceFiles.length,
      implementation: resolveMemoryHostImplementation(report.memoryHostSdk),
    },
  };
}

function buildReport(options: Partial<Pick<CliOptions, "owner" | "summary">> = {}): BoundaryReport {
  const records = listPluginCompatRecords().filter(
    (record) => options.owner === undefined || record.owner === options.owner,
  );
  const files = options.summary
    ? collectSummaryWorkspaceTextFileSources()
    : collectWorkspaceTextFileSources(records);
  const compatRecords = collectCompatDebt(records, files, new Date(), {
    includeReferenceFiles: !options.summary,
  });
  const removalPending = collectRemovalPendingDebt(records, files);
  return {
    generatedAt: new Date().toISOString(),
    compat: {
      deprecatedCount: compatRecords.length,
      eligibleForRemovalCount: compatRecords.filter((record) => record.eligibleForRemoval).length,
      records: compatRecords,
      removalPendingCount: removalPending.length,
      removalPendingDueCount: removalPending.filter((record) => record.dueForReview).length,
      removalPending,
    },
    pluginSdk: {
      entrypointCount: pluginSdkEntrypoints.length,
      supportedBundledFacadeCount: supportedBundledFacadeSdkEntrypoints.length,
      publicPluginOwnedCount: publicPluginOwnedSdkEntrypoints.length,
    },
    memoryHostSdk: collectMemoryHostBoundary(files),
  };
}

function renderSummaryText(summary: BoundaryReportSummary): string {
  const lines: string[] = [];
  lines.push(`Plugin Boundary Report${summary.owner ? ` (${summary.owner})` : ""}`);
  lines.push("");
  lines.push(
    `compat deprecated=${summary.compat.deprecatedCount} eligibleForRemoval=${summary.compat.eligibleForRemovalCount} removalPending=${summary.compat.removalPendingCount} removalPendingDue=${summary.compat.removalPendingDueCount}`,
  );
  for (const record of summary.compat.removalPending) {
    lines.push(
      `  removal-pending ${formatRemovalGate(record)} ${record.code} due=${record.dueForReview} blocker=${record.blocker} readerRefs=${record.readerCount} readers=${record.readerSample.join(",") || "none"}`,
    );
  }
  lines.push(
    `plugin-sdk entrypoints=${summary.pluginSdk.entrypointCount} supportedBundledFacade=${summary.pluginSdk.supportedBundledFacadeCount} publicPluginOwned=${summary.pluginSdk.publicPluginOwnedCount}`,
  );
  lines.push(
    `memory-host-sdk implementation=${summary.memoryHostSdk.implementation} private=${summary.memoryHostSdk.privatePackage} exports=${summary.memoryHostSdk.exportedSubpathCount} sourceBridgeFiles=${summary.memoryHostSdk.sourceBridgeFileCount} coreReferenceFiles=${summary.memoryHostSdk.packageCoreReferenceFileCount}`,
  );
  return lines.join("\n");
}

function renderText(report: BoundaryReport, owner?: string): string {
  const lines: string[] = [];
  lines.push(`Plugin Boundary Report${owner ? ` (${owner})` : ""}`);
  lines.push("");
  lines.push(
    `compat deprecated=${report.compat.deprecatedCount} eligibleForRemoval=${report.compat.eligibleForRemovalCount} removalPending=${report.compat.removalPendingCount} removalPendingDue=${report.compat.removalPendingDueCount}`,
  );
  for (const record of report.compat.records) {
    lines.push(
      `  ${formatRemovalGate(record)} ${record.code} owner=${record.owner} codeRefs=${record.codeReferenceFiles.length} docRefs=${record.docReferenceFiles.length}`,
    );
  }
  for (const record of report.compat.removalPending) {
    lines.push(
      `  removal-pending ${formatRemovalGate(record)} ${record.code} due=${record.dueForReview} blocker=${record.blocker} readerRefs=${record.readerFiles.length}`,
    );
    for (const reader of record.readerFiles) {
      lines.push(`    reader ${reader}`);
    }
  }
  lines.push("");
  lines.push(
    `plugin-sdk entrypoints=${report.pluginSdk.entrypointCount} supportedBundledFacade=${report.pluginSdk.supportedBundledFacadeCount} publicPluginOwned=${report.pluginSdk.publicPluginOwnedCount}`,
  );
  lines.push("");
  lines.push(
    `memory-host-sdk implementation=${resolveMemoryHostImplementation(report.memoryHostSdk)} private=${report.memoryHostSdk.privatePackage} exports=${report.memoryHostSdk.exportedSubpaths.length} sourceBridgeFiles=${report.memoryHostSdk.sourceBridgeFiles.length} coreReferenceFiles=${report.memoryHostSdk.packageCoreReferenceFiles.length}`,
  );
  return lines.join("\n");
}

function collectFailures(report: BoundaryReport, options: CliOptions): string[] {
  const failures: string[] = [];
  if (options.failOnEligibleCompat && report.compat.eligibleForRemovalCount > 0) {
    failures.push(
      `${report.compat.eligibleForRemovalCount} compatibility record(s) are due for removal`,
    );
  }
  return failures;
}

export function createPluginBoundaryReport(args: readonly string[]): PluginBoundaryReportResult {
  const options = parseArgs(args);
  if (options.help) {
    return {
      stdout: `${renderHelp()}\n`,
      stderr: "",
      exitCode: 0,
    };
  }

  const report = buildReport(options);
  const summary = buildSummary(report, options.owner);
  const body = options.json
    ? JSON.stringify(options.summary ? summary : report, null, 2)
    : options.summary
      ? renderSummaryText(summary)
      : renderText(report, options.owner);
  const failures = collectFailures(report, options);
  return {
    stdout: `${body}\n`,
    stderr:
      failures.length > 0
        ? `${failures.map((failure) => `plugin-boundary-report: ${failure}`).join("\n")}\n`
        : "",
    exitCode: failures.length > 0 ? 1 : 0,
  };
}

function runPluginBoundaryReportCli(args: readonly string[]): void {
  let result: PluginBoundaryReportResult;
  try {
    result = createPluginBoundaryReport(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n\n${renderHelp()}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(result.stdout);
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPluginBoundaryReportCli(process.argv.slice(2));
}
