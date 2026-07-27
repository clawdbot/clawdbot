#!/usr/bin/env node

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";

const DEPENDENCY_FIELDS = [
  { name: "dependencies", optional: false },
  { name: "devDependencies", optional: false },
  { name: "optionalDependencies", optional: true },
];
const MAX_REPORTED_MISMATCHES = 12;

function readImporters(workspace) {
  const lockfilePath = path.join(workspace, "pnpm-lock.yaml");
  const lockfile = YAML.parse(readFileSync(lockfilePath, "utf8"));
  if (!lockfile?.importers || typeof lockfile.importers !== "object") {
    throw new Error(`${lockfilePath} does not contain importers`);
  }
  return lockfile.importers;
}

function registryResolution(dependencyName, resolution) {
  if (typeof resolution !== "string") {
    return undefined;
  }
  const locator = resolution.split("(", 1)[0];
  if (locator.includes(":")) {
    return undefined;
  }
  const versionSeparator = locator.startsWith("@")
    ? locator.indexOf("@", locator.indexOf("/") + 1)
    : locator.indexOf("@");
  if (versionSeparator > 0) {
    return {
      packageName: locator.slice(0, versionSeparator),
      snapshotKey: resolution,
      version: locator.slice(versionSeparator + 1),
    };
  }
  return {
    packageName: dependencyName,
    snapshotKey: `${dependencyName}@${resolution}`,
    version: locator,
  };
}

function packageNameParts(packageName) {
  const parts = packageName.split("/");
  const valid = packageName.startsWith("@")
    ? parts.length === 2 && parts.every(Boolean)
    : parts.length === 1 && parts[0] !== "";
  if (!valid || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`invalid dependency name from pnpm lockfile: ${packageName}`);
  }
  return parts;
}

function isWithinWorkspace(workspace, candidate) {
  const relative = path.relative(workspace, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function findInstalledManifest({ dependencyName, projectPath, workspace }) {
  const dependencyParts = packageNameParts(dependencyName);
  let current = projectPath;
  for (;;) {
    const candidate = path.join(current, "node_modules", ...dependencyParts, "package.json");
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw error;
      }
    }
    if (current === workspace) {
      return undefined;
    }
    const parent = path.dirname(current);
    if (parent === current || !isWithinWorkspace(workspace, parent)) {
      return undefined;
    }
    current = parent;
  }
}

function parseManifest(manifestPath) {
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${manifestPath}: ${error.message}`);
  }
}

function relativeDisplayPath(workspace, absolutePath) {
  const relative = path.relative(workspace, absolutePath);
  return relative || ".";
}

function normalizeLocation(location) {
  return location.split(path.sep).join("/");
}

function readHoistedResolutions(workspace) {
  const modulesMetadataPath = path.join(workspace, "node_modules", ".modules.yaml");
  const metadata = YAML.parse(readFileSync(modulesMetadataPath, "utf8"));
  if (!metadata?.hoistedLocations || typeof metadata.hoistedLocations !== "object") {
    throw new Error(`${modulesMetadataPath} does not contain hoistedLocations`);
  }
  const byLocation = new Map();
  const bySnapshotKey = new Map();
  for (const [snapshotKey, locations] of Object.entries(metadata.hoistedLocations)) {
    if (!Array.isArray(locations)) {
      throw new Error(`invalid hoistedLocations entry for ${snapshotKey}`);
    }
    for (const location of locations) {
      if (typeof location !== "string") {
        throw new Error(`invalid hoisted location for ${snapshotKey}`);
      }
      const normalized = normalizeLocation(location);
      const keys = byLocation.get(normalized) ?? new Set();
      keys.add(snapshotKey);
      byLocation.set(normalized, keys);
      const snapshotLocations = bySnapshotKey.get(snapshotKey) ?? new Set();
      snapshotLocations.add(normalized);
      bySnapshotKey.set(snapshotKey, snapshotLocations);
    }
  }
  return { byLocation, bySnapshotKey };
}

function readCapturedImporters(workspace, manifestPath) {
  const importers = new Map();
  for (const entry of readFileSync(manifestPath, "utf8").split("\n")) {
    if (!entry) {
      continue;
    }
    const modulesPath = path.resolve(workspace, entry);
    if (
      !isWithinWorkspace(workspace, modulesPath) ||
      path.basename(modulesPath) !== "node_modules" ||
      modulesPath === path.join(workspace, "node_modules")
    ) {
      throw new Error(`invalid importer manifest entry: ${entry}`);
    }
    const projectPath = path.dirname(modulesPath);
    const importerPath = relativeDisplayPath(workspace, projectPath);
    importers.set(importerPath, { modulesPath });
  }
  return importers;
}

function isPrunedImporter(importerPath) {
  // postinstall-bundled-plugins.mjs deliberately removes every plugin source
  // node_modules tree; installed plugins own those dependencies separately.
  return importerPath.startsWith("extensions/");
}

function verifyImporters(workspace, manifestPath) {
  const importers = readImporters(workspace);
  const hoistedResolutions = readHoistedResolutions(workspace);
  const capturedImporters = readCapturedImporters(workspace, manifestPath);
  const mismatches = [];
  let checked = 0;

  for (const [importerPath, { modulesPath }] of capturedImporters) {
    if (!importers[importerPath] || typeof importers[importerPath] !== "object") {
      throw new Error(`importer manifest entry is absent from pnpm-lock.yaml: ${importerPath}`);
    }
    try {
      if (!statSync(modulesPath).isDirectory()) {
        mismatches.push(`${importerPath}: captured node_modules path is not a directory`);
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") {
        throw error;
      }
      mismatches.push(`${importerPath}: captured node_modules directory is missing`);
    }
  }

  // The lockfile, not the captured manifest, owns the validation universe. A
  // missing importer must still be checked against the version Node falls back to.
  for (const [importerPath, importer] of Object.entries(importers)) {
    if (isPrunedImporter(importerPath)) {
      continue;
    }
    const projectPath = path.resolve(workspace, importerPath);
    if (!isWithinWorkspace(workspace, projectPath)) {
      throw new Error(`pnpm lockfile contains an importer outside the workspace: ${importerPath}`);
    }
    for (const field of DEPENDENCY_FIELDS) {
      const dependencies = importer[field.name] ?? {};
      for (const [dependencyName, expected] of Object.entries(dependencies)) {
        // Workspace, file, and git locators do not map directly to installed
        // manifest versions; registry versions and aliases do.
        const expectedResolution = registryResolution(dependencyName, expected?.version);
        if (!expectedResolution) {
          continue;
        }
        const manifestPath = findInstalledManifest({ dependencyName, projectPath, workspace });
        const importerDisplay = relativeDisplayPath(workspace, projectPath);
        if (!manifestPath) {
          if (field.optional) {
            continue;
          }
          mismatches.push(
            `${importerDisplay}: ${dependencyName} ${expectedResolution.version} is not resolvable`,
          );
          continue;
        }
        checked += 1;
        const installedLocation = normalizeLocation(
          relativeDisplayPath(workspace, path.dirname(manifestPath)),
        );
        const expectedLocation = normalizeLocation(
          path.join(
            importerPath === "." ? "" : importerPath,
            "node_modules",
            ...packageNameParts(dependencyName),
          ),
        );
        const exactImporterSlot = hoistedResolutions.bySnapshotKey
          .get(expectedResolution.snapshotKey)
          ?.has(expectedLocation);
        const installedSnapshotKeys = hoistedResolutions.byLocation.get(installedLocation);
        // Hoisted pnpm installs may intentionally share a different peer-context
        // variant from the root. Exact identity is required when pnpm metadata
        // says this importer owns the lockfile snapshot in its local slot.
        if (exactImporterSlot && !installedSnapshotKeys?.has(expectedResolution.snapshotKey)) {
          const actualKeys = installedSnapshotKeys
            ? [...installedSnapshotKeys].toSorted().join(", ")
            : "<missing metadata>";
          mismatches.push(
            `${importerDisplay}: ${dependencyName} expected pnpm snapshot ${expectedResolution.snapshotKey}, resolved ${actualKeys} from ${installedLocation}`,
          );
        }
        const actual = parseManifest(manifestPath);
        if (
          actual.name !== expectedResolution.packageName ||
          actual.version !== expectedResolution.version
        ) {
          const resolvedFrom = relativeDisplayPath(
            workspace,
            realpathSync(path.dirname(manifestPath)),
          );
          mismatches.push(
            `${importerDisplay}: ${dependencyName} expected ${expectedResolution.packageName}@${expectedResolution.version}, resolved ${actual.name ?? "<missing>"}@${actual.version ?? "<missing>"} from ${resolvedFrom}`,
          );
        }
      }
    }
  }

  if (mismatches.length > 0) {
    const visible = mismatches.slice(0, MAX_REPORTED_MISMATCHES);
    const remainder = mismatches.length - visible.length;
    const suffix = remainder > 0 ? `\n... and ${remainder} more` : "";
    throw new Error(
      `sticky importer dependency validation failed (${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}):\n${visible.join("\n")}${suffix}`,
    );
  }
  console.log(`Verified ${checked} registry-backed importer dependency resolutions`);
}

const workspace = path.resolve(process.argv[2] ?? process.cwd());
const manifestPath = path.resolve(process.argv[3] ?? "");
try {
  if (!process.argv[3]) {
    throw new Error("importer manifest path is required");
  }
  verifyImporters(workspace, manifestPath);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
