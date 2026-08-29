#!/usr/bin/env node

// Reports dependency ownership, closure, and risk surface from lockfile data.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parse as parseYaml } from "yaml";
import { pnpmLockfileDocuments } from "./lib/pnpm-lockfile-documents.mjs";
import { collectRootDependencyOwnershipAudit } from "./root-dependency-ownership-audit.mts";

const DEFAULT_OWNERSHIP_PATH = "scripts/lib/dependency-ownership.json";
const PROD_IMPORTER_SECTIONS = ["dependencies", "optionalDependencies"];
const TRANSITIVE_SECTIONS = ["dependencies", "optionalDependencies"];
const compareStrings = (left: string, right: string) => left.localeCompare(right);

type JsonObject = Record<string, unknown>;
type ImporterRecord = Record<string, unknown>;
type Lockfile = {
  importers?: Record<string, ImporterRecord>;
  packages?: Record<string, JsonObject>;
  snapshots?: Record<string, ImporterRecord>;
};
type RootDependency = {
  name: string;
  section: string;
  specifier: unknown;
  version: string;
};
type Closure = { missing: string[]; packageKeys: string[] };
type ReportParams = { ownershipPath?: string; repoRoot?: string };
type ParseOptions = {
  asJson: boolean;
  check: boolean;
  jsonPath: string | null;
  markdownPath: string | null;
};

function readJson(filePath: string): JsonObject {
  const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!isRecord(value)) {
    throw new Error(`${filePath} must contain an object`);
  }
  return value;
}

function normalizeDependencies(record: ImporterRecord = {}): RootDependency[] {
  const entries: RootDependency[] = [];
  for (const section of PROD_IMPORTER_SECTIONS) {
    const sectionRecord = record[section];
    if (!isRecord(sectionRecord)) {
      continue;
    }
    for (const [name, value] of Object.entries(sectionRecord)) {
      const version =
        value && typeof value === "object" && "version" in value ? value.version : value;
      const specifier =
        value && typeof value === "object" && "specifier" in value ? value.specifier : undefined;
      if (typeof version === "string") {
        entries.push({ name, section, specifier, version });
      }
    }
  }
  return entries.toSorted((left, right) => left.name.localeCompare(right.name));
}

/**
 * Extracts the package name from a pnpm lockfile package key.
 */
export function packageNameFromLockKey(lockKey: unknown) {
  if (typeof lockKey !== "string") {
    return lockKey;
  }
  const peerSuffixIndex = lockKey.indexOf("(");
  const baseKey = peerSuffixIndex >= 0 ? lockKey.slice(0, peerSuffixIndex) : lockKey;
  if (baseKey.startsWith("@")) {
    const secondAt = baseKey.indexOf("@", 1);
    return secondAt >= 0 ? baseKey.slice(0, secondAt) : baseKey;
  }
  const firstAt = baseKey.indexOf("@");
  return firstAt >= 0 ? baseKey.slice(0, firstAt) : baseKey;
}

function lockKeyForDependency(name: string, version: string) {
  if (!version || version.startsWith("link:") || version.startsWith("workspace:")) {
    return undefined;
  }
  if (version.startsWith("file:")) {
    return undefined;
  }
  if (version.startsWith("npm:")) {
    return version.slice("npm:".length);
  }
  if (version.startsWith("@")) {
    return version;
  }
  return `${name}@${version}`;
}

function dependencyEntriesFromSnapshot(snapshot: ImporterRecord = {}) {
  const entries: Array<{ name: string; version: string }> = [];
  for (const section of TRANSITIVE_SECTIONS) {
    const sectionRecord = snapshot[section];
    if (!isRecord(sectionRecord)) {
      continue;
    }
    for (const [name, version] of Object.entries(sectionRecord)) {
      if (typeof version === "string") {
        entries.push({ name, version });
      }
    }
  }
  return entries;
}

function collectClosure(lockfile: Lockfile, rootKeys: Array<string | undefined>): Closure {
  const seen = new Set<string>();
  const missing = new Set<string>();
  const queue = rootKeys.filter((key): key is string => typeof key === "string");
  while (queue.length > 0) {
    const key = queue.shift();
    if (key === undefined) {
      break;
    }
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const snapshot = lockfile.snapshots?.[key];
    if (!snapshot) {
      missing.add(key);
      continue;
    }
    for (const dependency of dependencyEntriesFromSnapshot(snapshot)) {
      const dependencyKey = lockKeyForDependency(dependency.name, dependency.version);
      if (dependencyKey && !seen.has(dependencyKey)) {
        queue.push(dependencyKey);
      }
    }
  }
  return {
    missing: [...missing].toSorted(compareStrings),
    packageKeys: [...seen].toSorted(compareStrings),
  };
}

function collectBuildRiskPackages(lockfile: Lockfile) {
  return Object.entries(lockfile.packages ?? {})
    .filter(([, record]) => record.requiresBuild || record.hasBin || record.os || record.cpu)
    .map(([lockKey, record]) => ({
      name: packageNameFromLockKey(lockKey),
      lockKey,
      requiresBuild: record.requiresBuild === true,
      hasBin: Boolean(record.hasBin),
      platformRestricted: Boolean(record.os || record.cpu || record.libc),
    }))
    .toSorted((left, right) => left.lockKey.localeCompare(right.lockKey));
}

function ownershipFor(dependencyOwnership: JsonObject, name: string) {
  const dependencies = isRecord(dependencyOwnership.dependencies)
    ? dependencyOwnership.dependencies
    : {};
  const ownership = dependencies[name];
  if (!isRecord(ownership)) {
    return undefined;
  }
  return {
    owner: typeof ownership.owner === "string" ? ownership.owner : undefined,
    class: typeof ownership.class === "string" ? ownership.class : undefined,
    risk: Array.isArray(ownership.risk)
      ? ownership.risk.filter((value): value is string => typeof value === "string")
      : [],
  };
}

function gitValue(repoRoot: string, args: string[]) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function collectReportTarget({
  repoRoot,
  packageJson,
  ownershipPath,
}: {
  ownershipPath: string;
  packageJson: JsonObject;
  repoRoot: string;
}) {
  return {
    packageName: typeof packageJson.name === "string" ? packageJson.name : null,
    packageVersion: typeof packageJson.version === "string" ? packageJson.version : null,
    gitBranch: gitValue(repoRoot, ["branch", "--show-current"]),
    gitCommit: gitValue(repoRoot, ["rev-parse", "HEAD"]),
    lockfile: "pnpm-lock.yaml",
    ownershipMetadata: path.relative(repoRoot, ownershipPath),
  };
}

/**
 * Collects dependency ownership and transitive surface metadata.
 */
export function collectDependencyOwnershipSurfaceReport(params: ReportParams = {}) {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const packageJson = readJson(path.join(repoRoot, "package.json"));
  const documents = pnpmLockfileDocuments(
    fs.readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8"),
  );
  const lockfile = parseYaml(documents.dependencies) as Lockfile;
  const allPackages = Object.values(documents)
    .filter((document) => document !== null)
    .map((document) => parseYaml(document) as Lockfile);
  const buildRiskPackages = allPackages
    .flatMap(collectBuildRiskPackages)
    .toSorted((left, right) => left.lockKey.localeCompare(right.lockKey));
  const ownershipPath = path.resolve(repoRoot, params.ownershipPath ?? DEFAULT_OWNERSHIP_PATH);
  const dependencyOwnership = readJson(ownershipPath);
  const rootImporter = lockfile.importers?.["."] ?? {};
  const rootDependencies = normalizeDependencies(rootImporter);
  const sourceAudit = new Map(
    collectRootDependencyOwnershipAudit({ repoRoot }).map((record) => [record.depName, record]),
  );
  const packageDependencies = isRecord(packageJson.dependencies) ? packageJson.dependencies : {};
  const packageOptionalDependencies = isRecord(packageJson.optionalDependencies)
    ? packageJson.optionalDependencies
    : {};

  const rootDependencyRows = rootDependencies.map((dependency) => {
    const rootKey = lockKeyForDependency(dependency.name, dependency.version);
    const closure = collectClosure(lockfile, rootKey ? [rootKey] : []);
    const ownership = ownershipFor(dependencyOwnership, dependency.name);
    const sourceRecord = sourceAudit.get(dependency.name);
    const sourceSections = sourceRecord?.sections ?? [];
    return {
      name: dependency.name,
      specifier:
        dependency.specifier ??
        packageDependencies[dependency.name] ??
        packageOptionalDependencies[dependency.name] ??
        null,
      section: dependency.section,
      resolved: dependency.version,
      owner: ownership?.owner ?? null,
      class: ownership?.class ?? null,
      risk: ownership?.risk ?? [],
      sourceCategory: sourceRecord?.category ?? null,
      sourceSections,
      sourceFileCount: sourceRecord?.fileCount ?? 0,
      closureSize: closure.packageKeys.length,
      missingSnapshotKeys: closure.missing,
    };
  });

  const rootClosure = collectClosure(
    lockfile,
    rootDependencies
      .map((dependency) => lockKeyForDependency(dependency.name, dependency.version))
      .filter(Boolean),
  );
  const importerClosures = Object.entries(lockfile.importers ?? {})
    .map(([importer, record]) => {
      const dependencies = normalizeDependencies(record);
      const closure = collectClosure(
        lockfile,
        dependencies
          .map((dependency) => lockKeyForDependency(dependency.name, dependency.version))
          .filter(Boolean),
      );
      return {
        importer,
        directDependencyCount: dependencies.length,
        closureSize: closure.packageKeys.length,
      };
    })
    .toSorted((left, right) => {
      if (right.closureSize !== left.closureSize) {
        return right.closureSize - left.closureSize;
      }
      return left.importer.localeCompare(right.importer);
    });

  const workspaceDependencyNames = new Set(
    Object.values(lockfile.importers ?? {}).flatMap((record) =>
      normalizeDependencies(record).map((dependency) => dependency.name),
    ),
  );
  const ownershipGaps = rootDependencies
    .filter((dependency) => !ownershipFor(dependencyOwnership, dependency.name))
    .map((dependency) => dependency.name)
    .toSorted(compareStrings);
  const staleOwnershipRecords = Object.keys(dependencyOwnership.dependencies ?? {})
    .filter((name) => !workspaceDependencyNames.has(name))
    .toSorted(compareStrings);
  const ownershipWarnings = rootDependencyRows
    .filter(
      (dependency) =>
        typeof dependency.owner === "string" &&
        dependency.owner.startsWith("plugin:") &&
        (dependency.sourceSections.includes("src") ||
          dependency.sourceSections.includes("packages") ||
          dependency.sourceSections.includes("ui")),
    )
    .map((dependency) => ({
      name: dependency.name,
      owner: dependency.owner,
      sourceSections: dependency.sourceSections,
      message: "plugin-owned dependency is still imported by core-owned source",
    }));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: collectReportTarget({ repoRoot, packageJson, ownershipPath }),
    summary: {
      importerCount: Object.keys(lockfile.importers ?? {}).length,
      lockfilePackageCount: new Set(
        allPackages.flatMap((document) => Object.keys(document.packages ?? {})),
      ).size,
      rootDirectDependencyCount: rootDependencies.length,
      rootClosurePackageCount: rootClosure.packageKeys.length,
      rootOwnershipRecordCount: Object.keys(dependencyOwnership.dependencies ?? {}).length,
      buildRiskPackageCount: buildRiskPackages.length,
    },
    ownershipGaps,
    staleOwnershipRecords,
    ownershipWarnings,
    buildRiskPackages,
    topRootDependencyCones: rootDependencyRows.toSorted((left, right) => {
      if (right.closureSize !== left.closureSize) {
        return right.closureSize - left.closureSize;
      }
      return left.name.localeCompare(right.name);
    }),
    rootDependencies: rootDependencyRows,
    importerClosures,
  };
}

type DependencyOwnershipReport = ReturnType<typeof collectDependencyOwnershipSurfaceReport>;

/**
 * Collects policy errors from a dependency ownership surface report.
 */
export function collectDependencyOwnershipSurfaceCheckErrors(report: DependencyOwnershipReport) {
  return report.ownershipGaps.map(
    (name) => `root dependency '${name}' is missing from ${DEFAULT_OWNERSHIP_PATH}`,
  );
}

function renderTargetPackage(target: DependencyOwnershipReport["target"]) {
  if (!target?.packageName && !target?.packageVersion) {
    return "unknown";
  }
  if (!target.packageName) {
    return target.packageVersion ?? "unknown";
  }
  if (!target.packageVersion) {
    return target.packageName;
  }
  return `${target.packageName}@${target.packageVersion}`;
}

function markdownCode(value: unknown) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Renders a dependency ownership surface report as Markdown.
 */
export function renderDependencyOwnershipSurfaceMarkdownReport(
  typedReport: DependencyOwnershipReport,
) {
  const lines = [
    "# Dependency Ownership and Install Surface Report",
    "",
    `Generated: ${typedReport.generatedAt}`,
    "",
    "## Target",
    "",
    `- Package: ${renderTargetPackage(typedReport.target)}`,
    `- Git branch: ${typedReport.target?.gitBranch ?? "unknown"}`,
    `- Git commit: ${typedReport.target?.gitCommit ?? "unknown"}`,
    `- Lockfile: ${typedReport.target?.lockfile ?? "pnpm-lock.yaml"}`,
    `- Ownership metadata: ${typedReport.target?.ownershipMetadata ?? DEFAULT_OWNERSHIP_PATH}`,
    "",
    "## Scope",
    "",
    "This report summarizes the dependency ownership and install-time surface represented by the current workspace lockfile. It uses the root package dependencies, workspace package entries from pnpm-lock.yaml, dependency ownership metadata, and lockfile package metadata such as build requirements, binaries, and platform restrictions.",
    "",
    "It is report-only. It does not query npm advisories and does not inspect published package manifests.",
    "",
    "## Summary",
    "",
    `- Workspace package entries in lockfile: ${typedReport.summary.importerCount}`,
    `- Packages in lockfile: ${typedReport.summary.lockfilePackageCount}`,
    `- Root direct dependencies: ${typedReport.summary.rootDirectDependencyCount}`,
    `- Packages reachable from root dependencies: ${typedReport.summary.rootClosurePackageCount}`,
    `- Packages with install-time or platform-specific behavior: ${typedReport.summary.buildRiskPackageCount}`,
    `- Root dependency ownership records: ${typedReport.summary.rootOwnershipRecordCount}`,
  ];
  if (typedReport.ownershipGaps.length > 0) {
    lines.push("", "## Root Dependencies Missing Ownership Metadata", "");
    for (const name of typedReport.ownershipGaps) {
      lines.push(`- ${markdownCode(name)}`);
    }
  }
  if (typedReport.ownershipWarnings.length > 0) {
    lines.push("", "## Dependency Ownership Mismatches", "");
    for (const warning of typedReport.ownershipWarnings) {
      lines.push(
        `- ${markdownCode(warning.name)}: ${warning.message}; source sections: ` +
          warning.sourceSections.join(", "),
      );
    }
  }
  if (typedReport.staleOwnershipRecords.length > 0) {
    lines.push("", "## Stale Ownership Metadata", "");
    for (const name of typedReport.staleOwnershipRecords) {
      lines.push(`- ${markdownCode(name)}`);
    }
  }

  lines.push("", "## Root Dependencies By Resolved Transitive Package Count", "");
  for (const dependency of typedReport.topRootDependencyCones) {
    const owner = dependency.owner ?? "unowned";
    lines.push(
      `- ${markdownCode(dependency.name)}: ` +
        `${pluralize(dependency.closureSize, "resolved transitive package")}; ` +
        `owner=${owner}; class=${dependency.class ?? "-"}`,
    );
  }

  lines.push("", "## Workspace Packages With The Most Dependencies", "");
  for (const importer of typedReport.importerClosures) {
    lines.push(
      `- ${markdownCode(importer.importer)}: ${pluralize(importer.closureSize, "package")}; ` +
        pluralize(importer.directDependencyCount, "direct dependency", "direct dependencies"),
    );
  }

  if (typedReport.buildRiskPackages.length > 0) {
    lines.push("", "## Packages With Install-Time Or Platform-Specific Behavior", "");
  }
  for (const dependency of typedReport.buildRiskPackages) {
    const traits: string[] = [];
    if (dependency.requiresBuild) {
      traits.push("requires build");
    }
    if (dependency.hasBin) {
      traits.push("has binary");
    }
    if (dependency.platformRestricted) {
      traits.push("platform-specific");
    }
    lines.push(`- ${markdownCode(dependency.lockKey)}: ${traits.join(", ") || "metadata present"}`);
  }

  return `${lines.join("\n")}\n`;
}

function printTextReport(report: DependencyOwnershipReport) {
  process.stdout.write(renderDependencyOwnershipSurfaceMarkdownReport(report));
}

function readArtifactPath(argv: string[], index: number, optionName: string) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

export function parseArgs(argv: string[]): ParseOptions {
  const options: ParseOptions = {
    asJson: false,
    check: false,
    jsonPath: null,
    markdownPath: null,
  };
  const seen = new Set<string>();
  const setOnce = <K extends keyof ParseOptions>(flag: string, key: K, value: ParseOptions[K]) => {
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once.`);
    }
    seen.add(flag);
    options[key] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--json") {
      if (seen.has(arg)) {
        throw new Error(`${arg} was provided more than once.`);
      }
      seen.add(arg);
      options.asJson = true;
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        index += 1;
        options.jsonPath = next;
      }
      continue;
    }
    if (arg === "--markdown") {
      setOnce(arg, "markdownPath", readArtifactPath(argv, index, arg));
      index += 1;
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }
  return options;
}

function writeArtifact(filePath: string | null, content: string) {
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function main(argv: string[] = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = collectDependencyOwnershipSurfaceReport();
  writeArtifact(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeArtifact(options.markdownPath, renderDependencyOwnershipSurfaceMarkdownReport(report));
  if (options.check) {
    const errors = collectDependencyOwnershipSurfaceCheckErrors(report);
    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[ownership-surface] ${error}`);
      }
      process.exitCode = 1;
      return;
    }
    if (!options.asJson) {
      console.error("[ownership-surface] ok");
      return;
    }
  }
  if (options.asJson && !options.jsonPath) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (options.asJson) {
    const artifactHint =
      typeof options.markdownPath === "string" ? " See ".concat(options.markdownPath, ".") : "";
    process.stdout.write(
      `INFO dependency ownership/install surface report: ` +
        `${report.summary.importerCount} workspace package entries, ` +
        `${report.summary.lockfilePackageCount} lockfile packages, ` +
        `${report.ownershipGaps.length} root dependencies missing ownership metadata; ` +
        `report-only.${artifactHint}\n`,
    );
    return;
  }
  printTextReport(report);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
