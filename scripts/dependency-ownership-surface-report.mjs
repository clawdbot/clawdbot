#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { collectRootDependencyOwnershipAudit } from "./root-dependency-ownership-audit.mjs";

const DEFAULT_OWNERSHIP_PATH = "scripts/lib/dependency-ownership.json";
const PROD_IMPORTER_SECTIONS = ["dependencies", "optionalDependencies"];
const TRANSITIVE_SECTIONS = ["dependencies", "optionalDependencies"];
const compareStrings = (left, right) => left.localeCompare(right);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readLockfile(filePath) {
  return parseYaml(fs.readFileSync(filePath, "utf8"));
}

function normalizeDependencies(record = {}) {
  const entries = [];
  for (const section of PROD_IMPORTER_SECTIONS) {
    for (const [name, value] of Object.entries(record[section] ?? {})) {
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

export function packageNameFromLockKey(lockKey) {
  const peerSuffixIndex = lockKey.indexOf("(");
  const baseKey = peerSuffixIndex >= 0 ? lockKey.slice(0, peerSuffixIndex) : lockKey;
  if (baseKey.startsWith("@")) {
    const secondAt = baseKey.indexOf("@", 1);
    return secondAt >= 0 ? baseKey.slice(0, secondAt) : baseKey;
  }
  const firstAt = baseKey.indexOf("@");
  return firstAt >= 0 ? baseKey.slice(0, firstAt) : baseKey;
}

function lockKeyForDependency(name, version) {
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

function dependencyEntriesFromSnapshot(snapshot = {}) {
  const entries = [];
  for (const section of TRANSITIVE_SECTIONS) {
    for (const [name, version] of Object.entries(snapshot[section] ?? {})) {
      if (typeof version === "string") {
        entries.push({ name, version });
      }
    }
  }
  return entries;
}

function collectClosure(lockfile, rootKeys) {
  const seen = new Set();
  const missing = new Set();
  const queue = [...rootKeys].filter(Boolean);
  while (queue.length > 0) {
    const key = queue.shift();
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

function collectBuildRiskPackages(lockfile) {
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

function ownershipFor(dependencyOwnership, name) {
  return dependencyOwnership.dependencies?.[name];
}

function gitValue(repoRoot, args) {
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

function collectReportTarget({ repoRoot, packageJson, ownershipPath }) {
  return {
    packageName: packageJson.name ?? null,
    packageVersion: packageJson.version ?? null,
    gitBranch: gitValue(repoRoot, ["branch", "--show-current"]),
    gitCommit: gitValue(repoRoot, ["rev-parse", "HEAD"]),
    lockfile: "pnpm-lock.yaml",
    ownershipMetadata: path.relative(repoRoot, ownershipPath),
  };
}

export function collectDependencyOwnershipSurfaceReport(params = {}) {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const packageJson = readJson(path.join(repoRoot, "package.json"));
  const lockfile = readLockfile(path.join(repoRoot, "pnpm-lock.yaml"));
  const ownershipPath = path.resolve(repoRoot, params.ownershipPath ?? DEFAULT_OWNERSHIP_PATH);
  const dependencyOwnership = readJson(ownershipPath);
  const rootImporter = lockfile.importers?.["."] ?? {};
  const rootDependencies = normalizeDependencies(rootImporter);
  const sourceAudit = new Map(
    collectRootDependencyOwnershipAudit({ repoRoot }).map((record) => [record.depName, record]),
  );

  const rootDependencyRows = rootDependencies.map((dependency) => {
    const rootKey = lockKeyForDependency(dependency.name, dependency.version);
    const closure = collectClosure(lockfile, rootKey ? [rootKey] : []);
    const ownership = ownershipFor(dependencyOwnership, dependency.name);
    const sourceRecord = sourceAudit.get(dependency.name);
    return {
      name: dependency.name,
      specifier:
        dependency.specifier ??
        packageJson.dependencies?.[dependency.name] ??
        packageJson.optionalDependencies?.[dependency.name] ??
        null,
      section: dependency.section,
      resolved: dependency.version,
      owner: ownership?.owner ?? null,
      class: ownership?.class ?? null,
      risk: ownership?.risk ?? [],
      sourceCategory: sourceRecord?.category ?? null,
      sourceSections: sourceRecord?.sections ?? [],
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
        dependency.owner?.startsWith("plugin:") &&
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
      lockfilePackageCount: Object.keys(lockfile.packages ?? {}).length,
      rootDirectDependencyCount: rootDependencies.length,
      rootClosurePackageCount: rootClosure.packageKeys.length,
      rootOwnershipRecordCount: Object.keys(dependencyOwnership.dependencies ?? {}).length,
      buildRiskPackageCount: collectBuildRiskPackages(lockfile).length,
    },
    ownershipGaps,
    staleOwnershipRecords,
    ownershipWarnings,
    buildRiskPackages: collectBuildRiskPackages(lockfile),
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

export function collectDependencyOwnershipSurfaceCheckErrors(report) {
  return report.ownershipGaps.map(
    (name) => `root dependency '${name}' is missing from ${DEFAULT_OWNERSHIP_PATH}`,
  );
}

function renderTargetPackage(target) {
  if (!target?.packageName && !target?.packageVersion) {
    return "unknown";
  }
  if (!target.packageName) {
    return target.packageVersion;
  }
  if (!target.packageVersion) {
    return target.packageName;
  }
  return `${target.packageName}@${target.packageVersion}`;
}

function markdownCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function renderDependencyOwnershipSurfaceMarkdownReport(report) {
  const lines = [
    "# Dependency Ownership and Install Surface Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Target",
    "",
    `- Package: ${renderTargetPackage(report.target)}`,
    `- Git branch: ${report.target?.gitBranch ?? "unknown"}`,
    `- Git commit: ${report.target?.gitCommit ?? "unknown"}`,
    `- Lockfile: ${report.target?.lockfile ?? "pnpm-lock.yaml"}`,
    `- Ownership metadata: ${report.target?.ownershipMetadata ?? DEFAULT_OWNERSHIP_PATH}`,
    "",
    "## Scope",
    "",
    "This report summarizes the dependency ownership and install-time surface represented by the current workspace lockfile. It uses the root package dependencies, workspace package entries from pnpm-lock.yaml, dependency ownership metadata, and lockfile package metadata such as build requirements, binaries, and platform restrictions.",
    "",
    "It is report-only. It does not query npm advisories and does not inspect published package manifests.",
    "",
    "## Summary",
    "",
    `- Workspace package entries in lockfile: ${report.summary.importerCount}`,
    `- Packages in lockfile: ${report.summary.lockfilePackageCount}`,
    `- Root direct dependencies: ${report.summary.rootDirectDependencyCount}`,
    `- Packages reachable from root dependencies: ${report.summary.rootClosurePackageCount}`,
    `- Packages with install-time or platform-specific behavior: ${report.summary.buildRiskPackageCount}`,
    `- Root dependency ownership records: ${report.summary.rootOwnershipRecordCount}`,
  ];
  if (report.ownershipGaps.length > 0) {
    lines.push("", "## Root Dependencies Missing Ownership Metadata", "");
    for (const name of report.ownershipGaps) {
      lines.push(`- ${markdownCode(name)}`);
    }
  }
  if (report.ownershipWarnings.length > 0) {
    lines.push("", "## Dependency Ownership Mismatches", "");
    for (const warning of report.ownershipWarnings) {
      lines.push(
        `- ${markdownCode(warning.name)}: ${warning.message}; source sections: ` +
          `${warning.sourceSections.join(", ")}`,
      );
    }
  }
  if (report.staleOwnershipRecords.length > 0) {
    lines.push("", "## Stale Ownership Metadata", "");
    for (const name of report.staleOwnershipRecords) {
      lines.push(`- ${markdownCode(name)}`);
    }
  }

  lines.push("", "## Root Dependencies By Resolved Transitive Package Count", "");
  for (const dependency of report.topRootDependencyCones) {
    const owner = dependency.owner ?? "unowned";
    lines.push(
      `- ${markdownCode(dependency.name)}: ` +
        `${pluralize(dependency.closureSize, "resolved transitive package")}; ` +
        `owner=${owner}; class=${dependency.class ?? "-"}`,
    );
  }

  lines.push("", "## Workspace Packages With The Most Dependencies", "");
  for (const importer of report.importerClosures) {
    lines.push(
      `- ${markdownCode(importer.importer)}: ${pluralize(importer.closureSize, "package")}; ` +
        pluralize(importer.directDependencyCount, "direct dependency", "direct dependencies"),
    );
  }

  if (report.buildRiskPackages.length > 0) {
    lines.push("", "## Packages With Install-Time Or Platform-Specific Behavior", "");
  }
  for (const dependency of report.buildRiskPackages) {
    const traits = [];
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

const renderTextReport = renderDependencyOwnershipSurfaceMarkdownReport;

function printTextReport(report) {
  process.stdout.write(renderTextReport(report));
}

function parseArgs(argv) {
  const options = {
    asJson: false,
    check: false,
    jsonPath: null,
    markdownPath: null,
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
      options.asJson = true;
      if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
        options.jsonPath = argv[++index];
      }
      continue;
    }
    if (arg === "--markdown") {
      options.markdownPath = argv[++index];
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }
  return options;
}

function writeArtifact(filePath, content) {
  if (!filePath) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = collectDependencyOwnershipSurfaceReport();
  writeArtifact(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeArtifact(options.markdownPath, renderTextReport(report));
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
      typeof options.markdownPath === "string" ? " See " + options.markdownPath + "." : "";
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
