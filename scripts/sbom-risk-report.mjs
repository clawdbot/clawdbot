#!/usr/bin/env node

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

export function collectSbomRiskReport(params = {}) {
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
    buildRiskPackages: collectBuildRiskPackages(lockfile).slice(0, 50),
    topRootDependencyCones: rootDependencyRows
      .toSorted((left, right) => {
        if (right.closureSize !== left.closureSize) {
          return right.closureSize - left.closureSize;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, 20),
    rootDependencies: rootDependencyRows,
    importerClosures: importerClosures.slice(0, 30),
  };
}

export function collectSbomRiskCheckErrors(report) {
  return report.ownershipGaps.map(
    (name) => `root dependency '${name}' is missing from ${DEFAULT_OWNERSHIP_PATH}`,
  );
}

function printTextReport(report) {
  console.log("# SBOM dependency risk report");
  console.log("");
  console.log(`importers: ${report.summary.importerCount}`);
  console.log(`lockfile packages: ${report.summary.lockfilePackageCount}`);
  console.log(`root direct dependencies: ${report.summary.rootDirectDependencyCount}`);
  console.log(`root closure packages: ${report.summary.rootClosurePackageCount}`);
  console.log(`build/native/bin risk packages: ${report.summary.buildRiskPackageCount}`);
  console.log(`ownership records: ${report.summary.rootOwnershipRecordCount}`);
  if (report.ownershipGaps.length > 0) {
    console.log("");
    console.log("## Ownership gaps");
    for (const name of report.ownershipGaps) {
      console.log(`- ${name}`);
    }
  }
  if (report.ownershipWarnings.length > 0) {
    console.log("");
    console.log("## Ownership warnings");
    for (const warning of report.ownershipWarnings) {
      console.log(`- ${warning.name}: ${warning.message} (${warning.sourceSections.join(",")})`);
    }
  }
  console.log("");
  console.log("## Largest root dependency cones");
  for (const dependency of report.topRootDependencyCones) {
    const owner = dependency.owner ?? "unowned";
    console.log(
      `- ${dependency.name}: closure=${dependency.closureSize} owner=${owner} class=${dependency.class ?? "-"}`,
    );
  }
  console.log("");
  console.log("## Largest importer closures");
  for (const importer of report.importerClosures.slice(0, 15)) {
    console.log(
      `- ${importer.importer}: closure=${importer.closureSize} direct=${importer.directDependencyCount}`,
    );
  }
}

function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes("--json");
  const check = argv.includes("--check");
  const report = collectSbomRiskReport();
  if (check) {
    const errors = collectSbomRiskCheckErrors(report);
    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[sbom-risk] ${error}`);
      }
      process.exitCode = 1;
      return;
    }
    if (!asJson) {
      console.error("[sbom-risk] ok");
      return;
    }
  }
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printTextReport(report);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
