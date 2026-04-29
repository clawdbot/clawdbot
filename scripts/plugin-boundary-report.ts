#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pluginSdkEntrypoints,
  publicPluginOwnedSdkEntrypoints,
  reservedBundledPluginSdkEntrypoints,
  supportedBundledFacadeSdkEntrypoints,
} from "../src/plugin-sdk/entrypoints.ts";
import { PLUGIN_COMPAT_RECORDS } from "../src/plugins/compat/registry.ts";
import type { PluginCompatRecord } from "../src/plugins/compat/types.ts";

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
const PLUGIN_SDK_SPECIFIER_PATTERN =
  /\b(?:from\s*["']|import\s*\(\s*["']|require\s*\(\s*["']|vi\.(?:mock|doMock)\s*\(\s*["'])(openclaw\/plugin-sdk\/([a-z0-9][a-z0-9-]*))["']/g;

type CliOptions = {
  json: boolean;
  summary: boolean;
  owner?: string;
  failOnCrossOwner: boolean;
  failOnEligibleCompat: boolean;
  failOnUnclassifiedUnusedReserved: boolean;
  help: boolean;
};

type CompatDebtRecord = {
  code: string;
  owner: string;
  status: PluginCompatRecord["status"];
  removeAfter?: string;
  replacement: string;
  docsPath: string;
  surfaces: readonly string[];
  tokens: string[];
  codeReferenceFiles: string[];
  docReferenceFiles: string[];
  eligibleForRemoval: boolean;
};

type WorkspaceTextFile = {
  file: string;
  relativeFile: string;
  source: string;
};

type ReservedSdkImport = {
  file: string;
  specifier: string;
  subpath: string;
  owner?: string;
  consumerOwner?: string;
  relation: "owner" | "cross-owner" | "workspace";
};

type BoundaryReport = {
  generatedAt: string;
  compat: {
    deprecatedCount: number;
    eligibleForRemovalCount: number;
    records: CompatDebtRecord[];
  };
  pluginSdk: {
    entrypointCount: number;
    reservedCount: number;
    supportedBundledFacadeCount: number;
    publicPluginOwnedCount: number;
    reservedImports: ReservedSdkImport[];
    crossOwnerReservedImports: ReservedSdkImport[];
    unusedReservedSubpaths: string[];
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
  };
  pluginSdk: {
    entrypointCount: number;
    reservedCount: number;
    supportedBundledFacadeCount: number;
    publicPluginOwnedCount: number;
    reservedImportCount: number;
    crossOwnerReservedImportCount: number;
    unusedReservedCount: number;
    unusedReservedSubpaths: string[];
    crossOwnerReservedImports: ReservedSdkImport[];
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

function collectWorkspaceTextFiles(): string[] {
  return SOURCE_ROOTS.flatMap((root) => collectTextFiles(resolve(REPO_ROOT, root))).toSorted(
    (left, right) => relative(REPO_ROOT, left).localeCompare(relative(REPO_ROOT, right)),
  );
}

function repoRelative(file: string): string {
  return relative(REPO_ROOT, file).replaceAll("\\", "/");
}

function collectWorkspaceTextFileSources(): WorkspaceTextFile[] {
  return collectWorkspaceTextFiles().map((file) => ({
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
    failOnCrossOwner: false,
    failOnEligibleCompat: false,
    failOnUnclassifiedUnusedReserved: false,
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
    } else if (arg === "--fail-on-cross-owner") {
      options.failOnCrossOwner = true;
    } else if (arg === "--fail-on-eligible-compat") {
      options.failOnEligibleCompat = true;
    } else if (arg === "--fail-on-unclassified-unused-reserved") {
      options.failOnUnclassifiedUnusedReserved = true;
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
    "  --owner <id>                           Filter compat/imports/reserved shims by owner id.",
    "  --fail-on-cross-owner                  Exit non-zero on cross-owner reserved SDK imports.",
    "  --fail-on-eligible-compat              Exit non-zero when deprecated compat is due for removal.",
    "  --fail-on-unclassified-unused-reserved Exit non-zero on unused reserved SDK shims.",
  ].join("\n");
}

function collectBundledPluginIds(): string[] {
  return readdirSync(resolve(REPO_ROOT, "extensions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted((left, right) => right.length - left.length || left.localeCompare(right));
}

function resolvePluginOwner(entrypoint: string, pluginIds: readonly string[]): string | undefined {
  return pluginIds.find(
    (pluginId) => entrypoint === pluginId || entrypoint.startsWith(`${pluginId}-`),
  );
}

function resolveConsumerOwner(file: string): string | undefined {
  return /^extensions\/([^/]+)\//u.exec(file)?.[1];
}

function extractCompatTokens(record: PluginCompatRecord): string[] {
  const tokens = new Set<string>();
  const values = [record.code, record.replacement, ...record.surfaces, ...record.diagnostics];
  for (const value of values) {
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

function collectCompatDebt(
  files: readonly WorkspaceTextFile[],
  today = new Date(),
  options: { includeReferenceFiles?: boolean } = {},
): CompatDebtRecord[] {
  return PLUGIN_COMPAT_RECORDS.filter((record) => record.status === "deprecated")
    .map((record) => {
      const tokens = extractCompatTokens(record);
      const references =
        options.includeReferenceFiles === false
          ? { codeReferenceFiles: [], docReferenceFiles: [] }
          : collectReferenceFiles(files, tokens);
      const eligibleForRemoval = record.removeAfter
        ? new Date(`${record.removeAfter}T00:00:00Z`) <= today
        : false;
      return {
        code: record.code,
        owner: record.owner,
        status: record.status,
        removeAfter: record.removeAfter,
        replacement: record.replacement,
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
        (left.removeAfter ?? "").localeCompare(right.removeAfter ?? "") ||
        left.owner.localeCompare(right.owner) ||
        left.code.localeCompare(right.code),
    );
}

function collectReservedSdkImports(files: readonly WorkspaceTextFile[]): ReservedSdkImport[] {
  const reserved = new Set<string>(reservedBundledPluginSdkEntrypoints);
  const pluginIds = collectBundledPluginIds();
  const imports: ReservedSdkImport[] = [];
  for (const { relativeFile, source } of files) {
    for (const match of source.matchAll(PLUGIN_SDK_SPECIFIER_PATTERN)) {
      const specifier = match[1];
      const subpath = match[2];
      if (!specifier || !subpath || !reserved.has(subpath)) {
        continue;
      }
      const owner = resolvePluginOwner(subpath, pluginIds);
      const consumerOwner = resolveConsumerOwner(relativeFile);
      const relation =
        owner && consumerOwner ? (owner === consumerOwner ? "owner" : "cross-owner") : "workspace";
      imports.push({ file: relativeFile, specifier, subpath, owner, consumerOwner, relation });
    }
  }
  return imports.toSorted(
    (left, right) =>
      left.subpath.localeCompare(right.subpath) ||
      left.file.localeCompare(right.file) ||
      left.specifier.localeCompare(right.specifier),
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
    if (source.includes("src/memory-host-sdk/")) {
      sourceBridgeFiles.push(relativeFile);
    }
    if (source.includes("../../../../src/") || source.includes("../../../src/")) {
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

function matchesOwner(owner: string | undefined, value: string | undefined): boolean {
  return owner === undefined || value === owner;
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
    },
    pluginSdk: {
      entrypointCount: report.pluginSdk.entrypointCount,
      reservedCount: report.pluginSdk.reservedCount,
      supportedBundledFacadeCount: report.pluginSdk.supportedBundledFacadeCount,
      publicPluginOwnedCount: report.pluginSdk.publicPluginOwnedCount,
      reservedImportCount: report.pluginSdk.reservedImports.length,
      crossOwnerReservedImportCount: report.pluginSdk.crossOwnerReservedImports.length,
      unusedReservedCount: report.pluginSdk.unusedReservedSubpaths.length,
      unusedReservedSubpaths: report.pluginSdk.unusedReservedSubpaths,
      crossOwnerReservedImports: report.pluginSdk.crossOwnerReservedImports,
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

function buildReport(options: Pick<CliOptions, "owner" | "summary"> = {}): BoundaryReport {
  const files = collectWorkspaceTextFileSources();
  const pluginIds = collectBundledPluginIds();
  const compatRecords = collectCompatDebt(files, new Date(), {
    includeReferenceFiles: !options.summary,
  }).filter((record) => matchesOwner(options.owner, record.owner));
  const reservedImports = collectReservedSdkImports(files).filter(
    (entry) =>
      matchesOwner(options.owner, entry.owner) || matchesOwner(options.owner, entry.consumerOwner),
  );
  const usedReserved = new Set(reservedImports.map((entry) => entry.subpath));
  const unusedReservedSubpaths = reservedBundledPluginSdkEntrypoints
    .filter(
      (subpath) =>
        !usedReserved.has(subpath) &&
        matchesOwner(options.owner, resolvePluginOwner(subpath, pluginIds)),
    )
    .toSorted((a, b) => a.localeCompare(b));
  return {
    generatedAt: new Date().toISOString(),
    compat: {
      deprecatedCount: compatRecords.length,
      eligibleForRemovalCount: compatRecords.filter((record) => record.eligibleForRemoval).length,
      records: compatRecords,
    },
    pluginSdk: {
      entrypointCount: pluginSdkEntrypoints.length,
      reservedCount: reservedBundledPluginSdkEntrypoints.length,
      supportedBundledFacadeCount: supportedBundledFacadeSdkEntrypoints.length,
      publicPluginOwnedCount: publicPluginOwnedSdkEntrypoints.length,
      reservedImports,
      crossOwnerReservedImports: reservedImports.filter(
        (entry) => entry.relation === "cross-owner",
      ),
      unusedReservedSubpaths,
    },
    memoryHostSdk: collectMemoryHostBoundary(files),
  };
}

function renderSummaryText(summary: BoundaryReportSummary): string {
  const lines: string[] = [];
  lines.push(`Plugin Boundary Report${summary.owner ? ` (${summary.owner})` : ""}`);
  lines.push("");
  lines.push(
    `compat deprecated=${summary.compat.deprecatedCount} eligibleForRemoval=${summary.compat.eligibleForRemovalCount}`,
  );
  lines.push(
    `plugin-sdk entrypoints=${summary.pluginSdk.entrypointCount} reserved=${summary.pluginSdk.reservedCount}`,
  );
  lines.push(
    `  reservedImports=${summary.pluginSdk.reservedImportCount} crossOwnerReservedImports=${summary.pluginSdk.crossOwnerReservedImportCount} unusedReserved=${summary.pluginSdk.unusedReservedCount}`,
  );
  for (const subpath of summary.pluginSdk.unusedReservedSubpaths) {
    lines.push(`  unused-reserved ${subpath}`);
  }
  for (const entry of summary.pluginSdk.crossOwnerReservedImports) {
    lines.push(`  cross-owner ${entry.file}: ${entry.specifier} owner=${entry.owner ?? "unknown"}`);
  }
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
    `compat deprecated=${report.compat.deprecatedCount} eligibleForRemoval=${report.compat.eligibleForRemovalCount}`,
  );
  for (const record of report.compat.records) {
    lines.push(
      `  ${record.removeAfter ?? "no-date"} ${record.code} owner=${record.owner} codeRefs=${record.codeReferenceFiles.length} docRefs=${record.docReferenceFiles.length}`,
    );
  }
  lines.push("");
  lines.push(
    `plugin-sdk entrypoints=${report.pluginSdk.entrypointCount} reserved=${report.pluginSdk.reservedCount} supportedBundledFacade=${report.pluginSdk.supportedBundledFacadeCount} publicPluginOwned=${report.pluginSdk.publicPluginOwnedCount}`,
  );
  lines.push(
    `  reservedImports=${report.pluginSdk.reservedImports.length} crossOwnerReservedImports=${report.pluginSdk.crossOwnerReservedImports.length} unusedReserved=${report.pluginSdk.unusedReservedSubpaths.length}`,
  );
  for (const subpath of report.pluginSdk.unusedReservedSubpaths) {
    lines.push(`  unused-reserved ${subpath}`);
  }
  for (const entry of report.pluginSdk.crossOwnerReservedImports) {
    lines.push(`  cross-owner ${entry.file}: ${entry.specifier} owner=${entry.owner ?? "unknown"}`);
  }
  lines.push("");
  lines.push(
    `memory-host-sdk implementation=${resolveMemoryHostImplementation(report.memoryHostSdk)} private=${report.memoryHostSdk.privatePackage} exports=${report.memoryHostSdk.exportedSubpaths.length} sourceBridgeFiles=${report.memoryHostSdk.sourceBridgeFiles.length} coreReferenceFiles=${report.memoryHostSdk.packageCoreReferenceFiles.length}`,
  );
  return lines.join("\n");
}

function collectFailures(report: BoundaryReport, options: CliOptions): string[] {
  const failures: string[] = [];
  if (options.failOnCrossOwner && report.pluginSdk.crossOwnerReservedImports.length > 0) {
    failures.push(
      `${report.pluginSdk.crossOwnerReservedImports.length} cross-owner reserved SDK import(s) found`,
    );
  }
  if (
    options.failOnUnclassifiedUnusedReserved &&
    report.pluginSdk.unusedReservedSubpaths.length > 0
  ) {
    failures.push(
      `${report.pluginSdk.unusedReservedSubpaths.length} unused reserved SDK subpath(s) found`,
    );
  }
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
