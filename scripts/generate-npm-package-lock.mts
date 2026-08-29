#!/usr/bin/env node
// Generates package-lock.json files that mirror pnpm lock policy for
// published packages while stripping dev-only dependency state.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import pMap from "p-map";
import { parse as parseYaml } from "yaml";
import { isRecord } from "../packages/normalization-core/src/record-coerce.ts";
import { listChangedPathsFromGit, listStagedChangedPaths } from "./changed-lanes.mts";
import { pnpmLockfileDocuments } from "./lib/pnpm-lockfile-documents.mjs";
import { resolveNpmRunner, type NpmRunnerParams } from "./npm-runner.mts";

type UnknownRecord = Record<string, unknown>;
type OverrideMap = Record<string, unknown>;
type ScopedOverrides = Record<string, Record<string, string>>;
type NpmLockCommandOptions = Omit<NpmRunnerParams, "npmArgs">;
type NpmLockExecInvocation = UnknownRecord & {
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
};
type NpmLockOptions = {
  env?: NodeJS.ProcessEnv;
  installStrategy?: "hoisted" | "nested" | "shallow" | "linked" | "" | null;
};

const SCRIPT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_DIR = path.resolve(
  process.env.OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT?.trim() || SCRIPT_ROOT_DIR,
);
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;
const NPM_LOCK_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const NPM_LOCK_COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const NPM_LOCK_DEFAULT_JOBS = 4;
const NPM_LOCK_MAX_JOBS = 16;
const NPM_LOCK_WORKER_KIND = "openclaw-npm-lock-package";

function usage() {
  return [
    "Usage: node scripts/generate-npm-package-lock.mjs [--all|--plugins|--changed|--package-dir <dir>] [--base <ref>] [--head <ref>] [--staged] [--jobs <count>]",
    "  default: root package only",
  ].join("\n");
}

function normalizeOverrideValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeOverrideValue(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalizeOverrideValue(nestedValue)]),
    );
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function"
  ) {
    return String(value);
  }
  return value;
}

function normalizeOverrides(overrides: unknown): OverrideMap {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return {};
  }
  const normalized: OverrideMap = {};
  for (const [key, value] of Object.entries(overrides)) {
    const scopedSeparator = key.indexOf(">");
    if (scopedSeparator > 0) {
      const parentSelector = key.slice(0, scopedSeparator).trim();
      const dependencyName = key.slice(scopedSeparator + 1).trim();
      if (parentSelector && dependencyName) {
        const current = normalized[parentSelector];
        const nested = isRecord(current) ? current : {};
        nested[dependencyName] = normalizeOverrideValue(value);
        normalized[parentSelector] = nested;
        continue;
      }
    }
    normalized[key] = normalizeOverrideValue(value);
  }
  return normalized;
}

function recordAt(value: unknown, key: string) {
  const nested = isRecord(value) ? value[key] : undefined;
  return isRecord(nested) ? nested : undefined;
}

function parseJsonObject(text: string): UnknownRecord {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error("expected a JSON object");
  }
  return value;
}

function readWorkspace() {
  const workspace: unknown = parseYaml(
    readFileSync(path.join(ROOT_DIR, "pnpm-workspace.yaml"), "utf8"),
  );
  return isRecord(workspace) ? workspace : {};
}

function readPnpmLock() {
  const lockfile: unknown = parseYaml(
    pnpmLockfileDocuments(readFileSync(path.join(ROOT_DIR, "pnpm-lock.yaml"), "utf8")).dependencies,
  );
  return lockfile;
}

function readWorkspaceOverrides() {
  return normalizeOverrides(readWorkspace().overrides);
}

function readWorkspacePackageExtensions() {
  return recordAt(readWorkspace(), "packageExtensions") ?? {};
}

function parsePnpmPackageKey(packageKey: unknown) {
  if (typeof packageKey !== "string") {
    return null;
  }
  const versionSeparatorIndex = packageKey.startsWith("@")
    ? packageKey.indexOf("@", 1)
    : packageKey.indexOf("@");
  if (versionSeparatorIndex <= 0) {
    return null;
  }
  const name = packageKey.slice(0, versionSeparatorIndex);
  const version = packageKey.slice(versionSeparatorIndex + 1).replace(/\(.*/u, "");
  if (!name || !version) {
    return null;
  }
  return { name, version };
}

function readPnpmLockPackages() {
  const lockfile = readPnpmLock();
  const packages = recordAt(lockfile, "packages");
  if (!packages) {
    throw new Error("pnpm-lock.yaml is missing package resolution data.");
  }
  const lockPackages = new Set<string>();
  for (const [packageKey, metadata] of Object.entries(packages)) {
    const parsed = parsePnpmPackageKey(packageKey);
    if (!parsed) {
      continue;
    }
    lockPackages.add(`${parsed.name}@${parsed.version}`);
    if (isRecord(metadata) && typeof metadata.version === "string") {
      lockPackages.add(`${parsed.name}@${metadata.version}`);
    }
  }
  return lockPackages;
}

function readPnpmLockPackageIntegrities() {
  const lockfile = readPnpmLock();
  const packages = recordAt(lockfile, "packages") ?? {};
  const integrities = new Map<string, Set<string>>();
  for (const [packageKey, metadata] of Object.entries(packages)) {
    const parsed = parsePnpmPackageKey(packageKey);
    const integrity = recordAt(metadata, "resolution")?.integrity;
    if (!parsed || typeof integrity !== "string") {
      continue;
    }
    const versions = new Set([parsed.version]);
    if (isRecord(metadata) && typeof metadata.version === "string") {
      versions.add(metadata.version);
    }
    for (const version of versions) {
      const key = `${parsed.name}@${version}`;
      const values = integrities.get(key) ?? new Set();
      values.add(integrity);
      integrities.set(key, values);
    }
  }
  return integrities;
}

function collectPnpmLockPackageVersions(lockfile: unknown) {
  const packages = recordAt(lockfile, "packages");
  if (!packages) {
    return new Map<string, Set<string>>();
  }
  const versionsByName = new Map<string, Set<string>>();
  for (const packageKey of Object.keys(packages)) {
    const parsed = parsePnpmPackageKey(packageKey);
    if (!parsed) {
      continue;
    }
    const versions = versionsByName.get(parsed.name) ?? new Set();
    versions.add(parsed.version);
    versionsByName.set(parsed.name, versions);
  }
  return versionsByName;
}

function stableVersionParts(version: string) {
  const match = version.match(STABLE_VERSION_PATTERN);
  return match
    ? {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
      }
    : null;
}

function pnpmLockOverrideVersionForVersions(versions: Iterable<string>) {
  const sortedVersions = [...versions].toSorted((left, right) => left.localeCompare(right));
  if (sortedVersions.length === 1) {
    const onlyVersion = sortedVersions[0];
    return exactVersionFromOverrideSpec(onlyVersion) === null ? null : (onlyVersion ?? null);
  }

  const parsedVersions = sortedVersions.flatMap((version) => {
    const parts = stableVersionParts(version);
    return parts ? [{ version, parts }] : [];
  });
  if (parsedVersions.length !== sortedVersions.length) {
    return null;
  }

  const firstParts = parsedVersions[0]?.parts;
  if (!firstParts) {
    return null;
  }
  if (
    parsedVersions.some(
      ({ parts }) => parts.major !== firstParts.major || parts.minor !== firstParts.minor,
    )
  ) {
    return null;
  }

  return (
    parsedVersions.toSorted((left, right) => right.parts.patch - left.parts.patch)[0]?.version ??
    null
  );
}

function addNestedOverride(
  overrides: ScopedOverrides,
  parentSelector: string,
  dependencyName: string,
  version: string,
  conflicts: Map<string, Set<string>>,
): void {
  const nested = overrides[parentSelector] ?? {};
  const existing = nested[dependencyName];
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(version)) {
    const parentConflicts = conflicts.get(parentSelector) ?? new Set();
    parentConflicts.add(dependencyName);
    conflicts.set(parentSelector, parentConflicts);
    return;
  }
  nested[dependencyName] = version;
  overrides[parentSelector] = nested;
}

function expandScopedOverrideValue(
  overrides: OverrideMap,
  dependencyName: string,
  version: string,
  seen = new Set<string>(),
): unknown {
  const childSelector = `${dependencyName}@${version}`;
  if (seen.has(childSelector)) {
    return version;
  }
  const childOverrides = overrides[childSelector];
  if (!isRecord(childOverrides)) {
    return version;
  }
  const childSeen = new Set(seen);
  childSeen.add(childSelector);
  return Object.fromEntries(
    [
      [".", version],
      ...Object.entries(childOverrides).map<[string, unknown]>(([nestedName, nestedVersion]) => [
        nestedName,
        typeof nestedVersion === "string"
          ? expandScopedOverrideValue(overrides, nestedName, nestedVersion, childSeen)
          : nestedVersion,
      ]),
    ].toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function expandScopedOverrideChildren(overrides: OverrideMap): OverrideMap {
  return Object.fromEntries(
    Object.entries(overrides)
      .map<[string, unknown]>(([parentSelector, nestedOverrides]) => {
        if (isRecord(nestedOverrides)) {
          return [
            parentSelector,
            Object.fromEntries(
              Object.entries(nestedOverrides)
                .map<[string, unknown]>(([dependencyName, version]) => [
                  dependencyName,
                  typeof version === "string"
                    ? expandScopedOverrideValue(overrides, dependencyName, version)
                    : version,
                ])
                .toSorted(([left], [right]) => left.localeCompare(right)),
            ),
          ];
        }
        if (typeof nestedOverrides !== "string") {
          return [parentSelector, nestedOverrides];
        }
        const exactVersion = exactVersionFromOverrideSpec(nestedOverrides);
        if (exactVersion === null || !isRecord(overrides[`${parentSelector}@${exactVersion}`])) {
          return [parentSelector, nestedOverrides];
        }
        return [parentSelector, expandScopedOverrideValue(overrides, parentSelector, exactVersion)];
      })
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function resolvePnpmLockOverridePlan(lockfile: unknown) {
  const versionsByName = collectPnpmLockPackageVersions(lockfile);
  if (versionsByName.size === 0) {
    throw new Error("pnpm-lock.yaml is missing package resolution data.");
  }
  const multiVersionPackageNames = new Set(
    [...versionsByName.entries()].filter(([, versions]) => versions.size > 1).map(([name]) => name),
  );

  const overrides: ScopedOverrides = {};
  const conflicts = new Map<string, Set<string>>();
  const snapshots = recordAt(lockfile, "snapshots") ?? {};
  for (const [snapshotKey, snapshot] of Object.entries(snapshots)) {
    const parent = parsePnpmPackageKey(snapshotKey);
    const dependencies = recordAt(snapshot, "dependencies");
    if (!parent || !dependencies) {
      continue;
    }
    const parentSelector = `${parent.name}@${parent.version}`;
    for (const [dependencyName, dependencySpec] of Object.entries(dependencies)) {
      if (!multiVersionPackageNames.has(dependencyName)) {
        continue;
      }
      const version = exactVersionFromOverrideSpec(String(dependencySpec));
      if (!version || !versionsByName.get(dependencyName)?.has(version)) {
        continue;
      }
      addNestedOverride(overrides, parentSelector, dependencyName, version, conflicts);
    }
  }

  const conflictingPackageNames = new Set<string>();
  for (const dependencyNames of conflicts.values()) {
    for (const dependencyName of dependencyNames) {
      conflictingPackageNames.add(dependencyName);
    }
  }
  const versionOverrides: Record<string, string> = {};
  const scopedPackageNames = new Set<string>();
  for (const [name, versions] of versionsByName.entries()) {
    const version = pnpmLockOverrideVersionForVersions(versions);
    if (versions.size === 1) {
      if (version !== null) {
        versionOverrides[name] = version;
      }
      continue;
    }
    if (version !== null && conflictingPackageNames.has(name)) {
      versionOverrides[name] = version;
      continue;
    }
    scopedPackageNames.add(name);
  }

  const scopedOverrides: ScopedOverrides = {};
  for (const [parentSelector, nestedOverrides] of Object.entries(overrides)) {
    const parentConflicts = conflicts.get(parentSelector) ?? new Set();
    const filtered = Object.fromEntries(
      Object.entries(nestedOverrides).filter(
        ([dependencyName]) =>
          scopedPackageNames.has(dependencyName) && !parentConflicts.has(dependencyName),
      ),
    );
    if (Object.keys(filtered).length > 0) {
      scopedOverrides[parentSelector] = filtered;
    }
  }

  return {
    conflictingPackageNames: [...conflictingPackageNames].toSorted((left, right) =>
      left.localeCompare(right),
    ),
    scopedVersionOverrides: expandScopedOverrideChildren(scopedOverrides),
    versionOverrides: Object.fromEntries(
      Object.entries(versionOverrides).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  };
}
function mergeOverrideEntry(merged: OverrideMap, name: string, spec: unknown): void {
  const current = merged[name];
  if (current === undefined) {
    merged[name] = spec;
    return;
  }
  if (isRecord(current) && isRecord(spec)) {
    for (const [nestedName, nestedSpec] of Object.entries(spec)) {
      mergeOverrideEntry(current, nestedName, nestedSpec);
    }
    return;
  }
  if (
    typeof current === "string" &&
    isRecord(spec) &&
    typeof spec["."] === "string" &&
    exactOverrideVersionsMatch(current, spec["."])
  ) {
    const mergedEntry = { ".": preferredExactOverrideRootSpec(current, spec["."]) };
    merged[name] = mergedEntry;
    for (const [nestedName, nestedSpec] of Object.entries(spec)) {
      if (nestedName === ".") {
        continue;
      }
      mergeOverrideEntry(mergedEntry, nestedName, nestedSpec);
    }
    return;
  }
  if (
    isRecord(current) &&
    typeof spec === "string" &&
    typeof current["."] === "string" &&
    exactOverrideVersionsMatch(current["."], spec)
  ) {
    current["."] = preferredExactOverrideRootSpec(current["."], spec);
    return;
  }
  if (JSON.stringify(current) !== JSON.stringify(spec)) {
    throw new Error(`package.json overrides.${name} conflicts with pnpm lock policy for ${name}`);
  }
}

function preferredExactOverrideRootSpec(current: string, incoming: string) {
  return incoming.startsWith("npm:") ? incoming : current;
}

function exactOverrideVersionsMatch(left: string, right: string) {
  const leftVersion = exactVersionFromOverrideSpec(left);
  if (leftVersion === null || leftVersion !== exactVersionFromOverrideSpec(right)) {
    return false;
  }
  const leftAlias = parseNpmAliasOverrideSpec(left);
  const rightAlias = parseNpmAliasOverrideSpec(right);
  return !leftAlias || !rightAlias || leftAlias.name === rightAlias.name;
}

function parseNpmAliasOverrideSpec(spec: string) {
  if (!spec.startsWith("npm:")) {
    return null;
  }
  const versionIndex = spec.lastIndexOf("@");
  if (versionIndex <= "npm:".length) {
    return null;
  }
  return { name: spec.slice("npm:".length, versionIndex) };
}

function mergeOverrides(
  packageOverrides: unknown,
  workspaceOverrides: OverrideMap,
  pnpmLockOverrides: OverrideMap,
): OverrideMap | undefined {
  const merged = normalizeOverrides(packageOverrides);
  for (const [name, spec] of [
    ...Object.entries(workspaceOverrides),
    ...Object.entries(pnpmLockOverrides),
  ]) {
    mergeOverrideEntry(merged, name, spec);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function readNpmLockOverrides() {
  const lockfile = readPnpmLock();
  const plan = resolvePnpmLockOverridePlan(lockfile);
  const plannedOverrides =
    mergeOverrides(plan.versionOverrides, plan.scopedVersionOverrides, {}) ?? {};
  const mergedOverrides =
    mergeOverrides(undefined, readWorkspaceOverrides(), plannedOverrides) ?? {};
  return expandScopedOverrideChildren(mergedOverrides);
}

function packageJsonForNpmLock(packageJson: UnknownRecord, npmLockOverrides: OverrideMap) {
  const normalized = { ...packageJson };
  delete normalized.bundleDependencies;
  delete normalized.bundledDependencies;
  delete normalized.devDependencies;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = recordAt(normalized, field);
    if (!dependencies) {
      continue;
    }
    normalized[field] = Object.fromEntries(
      Object.entries(dependencies).filter(
        ([, spec]) => typeof spec !== "string" || !spec.startsWith("workspace:"),
      ),
    );
  }
  normalized.overrides = mergeOverrides(packageJson.overrides, npmLockOverrides, {});
  return normalized;
}

function copyLocalFileDependencies(
  packageJson: UnknownRecord,
  packageDir: string,
  tempDir: string,
) {
  const pending = [{ manifest: packageJson, packageDir }];
  const copied = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current) {
      continue;
    }
    for (const field of ["dependencies", "optionalDependencies"]) {
      const dependencies = current.manifest[field];
      for (const spec of Object.values(isRecord(dependencies) ? dependencies : {})) {
        if (typeof spec !== "string" || !spec.startsWith("file:")) {
          continue;
        }
        const source = path.resolve(current.packageDir, spec.slice("file:".length));
        const relative = path.relative(packageDir, source);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error(`npm package lock file dependency escapes package root: ${spec}`);
        }
        if (copied.has(relative)) {
          continue;
        }
        copied.add(relative);
        cpSync(source, path.join(tempDir, relative), { recursive: true });
        const nestedManifestPath = path.join(source, "package.json");
        if (existsSync(nestedManifestPath)) {
          pending.push({
            manifest: parseJsonObject(readFileSync(nestedManifestPath, "utf8")),
            packageDir: source,
          });
        }
      }
    }
  }
}

/**
 * Resolves the npm command invocation used by npm-lock generation.
 * @internal Directly tested script implementation detail.
 */
export function createNpmLockCommand(args: string[], options: NpmLockCommandOptions = {}) {
  return resolveNpmRunner({
    comSpec: options.comSpec,
    env: options.env,
    execPath: options.execPath,
    existsSync: options.existsSync,
    npmArgs: args,
    platform: options.platform,
  });
}

/**
 * Reads a positive integer env override for npm-lock subprocess limits.
 * @internal Directly tested script implementation detail.
 */
export function readPositiveIntEnv(
  name: unknown,
  fallback: unknown,
  env: NodeJS.ProcessEnv = process.env,
) {
  const envName = String(name);
  const text = String(env[envName] ?? fallback).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${envName}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${envName}: ${text}`);
  }
  return value;
}

/**
 * Builds execFileSync options with bounded timeout and output buffer limits.
 * @internal Directly tested script implementation detail.
 */
export function createNpmLockExecOptions(
  invocation: NpmLockExecInvocation,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    cwd,
    env: invocation.env ?? env,
    maxBuffer: readPositiveIntEnv(
      "OPENCLAW_NPM_LOCK_COMMAND_MAX_BUFFER_BYTES",
      NPM_LOCK_COMMAND_MAX_BUFFER_BYTES,
      env,
    ),
    shell: invocation.shell,
    stdio: ["ignore", "pipe", "pipe"] satisfies ["ignore", "pipe", "pipe"],
    timeout: readPositiveIntEnv(
      "OPENCLAW_NPM_LOCK_COMMAND_TIMEOUT_MS",
      NPM_LOCK_COMMAND_TIMEOUT_MS,
      env,
    ),
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  };
}

function runNpm(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const npm = createNpmLockCommand(args, { env });
  execFileSync(npm.command, npm.args, createNpmLockExecOptions(npm, cwd, env));
}

function packageExtensionAppliesToDependency(selector: string, dependencyName: string) {
  return selector === dependencyName || selector.startsWith(`${dependencyName}@`);
}

function packageExtensionMarksOptionalPeer(packageExtension: unknown) {
  const peerMetadata = recordAt(packageExtension, "peerDependenciesMeta");
  return (
    peerMetadata !== undefined &&
    Object.values(peerMetadata).some((meta) => isRecord(meta) && meta.optional === true)
  );
}

function shouldUseLegacyPeerDepsForNpmLock(
  packageJson: UnknownRecord,
  packageExtensions = readWorkspacePackageExtensions(),
) {
  if (
    packageExtensionMarksOptionalPeer({ peerDependenciesMeta: packageJson.peerDependenciesMeta })
  ) {
    return true;
  }
  const dependencies = isRecord(packageJson.dependencies)
    ? Object.keys(packageJson.dependencies)
    : [];
  if (dependencies.length === 0) {
    return false;
  }
  for (const dependencyName of dependencies) {
    for (const [selector, packageExtension] of Object.entries(packageExtensions)) {
      if (
        packageExtensionAppliesToDependency(selector, dependencyName) &&
        packageExtensionMarksOptionalPeer(packageExtension)
      ) {
        return true;
      }
    }
  }
  return false;
}

function applyPackageExtensionPeerMetadata<T>(
  lockfile: T,
  packageExtensions = readWorkspacePackageExtensions(),
): T {
  const packages = recordAt(lockfile, "packages");
  if (!packages) {
    return lockfile;
  }

  for (const [lockPath, metadata] of Object.entries(packages)) {
    if (!isRecord(metadata)) {
      continue;
    }
    const packageName = metadata.name ?? parseLockPackagePath(lockPath).at(-1)?.name;
    const peerDependencies = recordAt(metadata, "peerDependencies");
    if (typeof packageName !== "string" || !peerDependencies) {
      continue;
    }
    for (const [selector, packageExtension] of Object.entries(packageExtensions)) {
      if (!packageExtensionAppliesToDependency(selector, packageName)) {
        continue;
      }
      const peerDependenciesMeta = recordAt(packageExtension, "peerDependenciesMeta");
      if (!peerDependenciesMeta) {
        continue;
      }
      for (const [peerName, peerMeta] of Object.entries(peerDependenciesMeta)) {
        if (peerDependencies[peerName] === undefined || !isRecord(peerMeta)) {
          continue;
        }
        const metadataByPeer = recordAt(metadata, "peerDependenciesMeta") ?? {};
        metadata.peerDependenciesMeta = metadataByPeer;
        const existingPeerMeta = metadataByPeer[peerName];
        metadataByPeer[peerName] = isRecord(existingPeerMeta)
          ? { ...existingPeerMeta, ...peerMeta }
          : { ...peerMeta };
      }
    }
  }

  return lockfile;
}

function exactVersionFromOverrideSpec(spec: unknown) {
  if (!spec || typeof spec !== "string") {
    return null;
  }
  if (EXACT_VERSION_PATTERN.test(spec)) {
    return spec;
  }
  if (!spec.startsWith("npm:")) {
    return null;
  }
  const versionIndex = spec.lastIndexOf("@");
  if (versionIndex <= "npm:".length) {
    return null;
  }
  const version = spec.slice(versionIndex + 1);
  return EXACT_VERSION_PATTERN.test(version) ? version : null;
}

function exactOverrideRulesFromOverrides(overrides: unknown) {
  return Object.fromEntries(
    Object.entries(normalizeOverrides(overrides)).flatMap<[string, string]>(([name, spec]) => {
      const version = exactVersionFromOverrideSpec(spec);
      return version === null ? [] : [[name, version]];
    }),
  );
}

function parseLockPackagePath(lockPath: unknown) {
  if (typeof lockPath !== "string") {
    return [];
  }
  if (!lockPath.startsWith("node_modules/")) {
    return [];
  }
  const packages: { name: string; path: string }[] = [];
  let remaining = lockPath;
  let current = "";
  while (remaining.startsWith("node_modules/")) {
    const withoutPrefix = remaining.slice("node_modules/".length);
    const segments = withoutPrefix.split("/");
    const name = segments[0]?.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
    if (!name) {
      return packages;
    }
    current = current ? `${current}/node_modules/${name}` : `node_modules/${name}`;
    packages.push({ name, path: current });
    remaining = withoutPrefix.slice(name.length);
    if (remaining.startsWith("/")) {
      remaining = remaining.slice(1);
    }
  }
  return packages;
}

type OverrideViolation = {
  actualVersion: string;
  expectedVersion: string;
  packageName: string;
  packagePath: Array<{ name: string; path: string }>;
  path: string;
};

function collectOverrideViolations(
  lockfile: unknown,
  overrideRules: Record<string, string>,
): OverrideViolation[] {
  const packages = recordAt(lockfile, "packages");
  if (!packages) {
    return [];
  }
  const violations: OverrideViolation[] = [];
  for (const [lockPath, metadata] of Object.entries(packages)) {
    const packagePath = parseLockPackagePath(lockPath);
    const packageName = packagePath.at(-1)?.name;
    if (!packageName) {
      continue;
    }
    const expectedVersion = overrideRules[packageName];
    const actualVersion =
      isRecord(metadata) && typeof metadata.version === "string" ? metadata.version : undefined;
    if (!expectedVersion || actualVersion === expectedVersion) {
      continue;
    }
    violations.push({
      path: lockPath,
      packageName,
      actualVersion: actualVersion ?? "<missing>",
      expectedVersion,
      packagePath,
    });
  }
  return violations;
}

function disableDependencyShrinkwrapOverrideConflictSources(
  lockfile: unknown,
  overrideRules: Record<string, string>,
) {
  const packages = recordAt(lockfile, "packages");
  if (!packages) {
    return [];
  }
  const disabled = new Set<string>();
  for (const violation of collectOverrideViolations(lockfile, overrideRules)) {
    const ancestors = violation.packagePath.slice(0, -1).toReversed();
    const shrinkwrappedAncestor = ancestors.find((ancestor) => {
      const metadata = packages[ancestor.path];
      return isRecord(metadata) && metadata.hasShrinkwrap === true;
    });
    if (!shrinkwrappedAncestor) {
      continue;
    }
    const ancestorMetadata = packages[shrinkwrappedAncestor.path];
    if (isRecord(ancestorMetadata)) {
      delete ancestorMetadata.hasShrinkwrap;
    }
    disabled.add(shrinkwrappedAncestor.path);
  }
  for (const ancestorPath of disabled) {
    const subtreePrefix = `${ancestorPath}/node_modules/`;
    for (const lockPath of Object.keys(packages)) {
      if (lockPath.startsWith(subtreePrefix)) {
        delete packages[lockPath];
      }
    }
  }
  return [...disabled].toSorted((left, right) => left.localeCompare(right));
}

function describeOverrideViolations(violations: ReturnType<typeof collectOverrideViolations>) {
  return violations
    .slice(0, 5)
    .map(
      (violation) =>
        `${violation.path} locked ${violation.actualVersion}, expected ${violation.expectedVersion}`,
    )
    .join("; ");
}

function normalizeNpmLockOverrides(
  tempDir: string,
  npmLockOverrides: OverrideMap,
  npmInstallArgs: string[],
  env: NodeJS.ProcessEnv,
) {
  const npmLockPath = path.join(tempDir, "package-lock.json");
  const overrideRules = exactOverrideRulesFromOverrides(npmLockOverrides);
  if (Object.keys(overrideRules).length === 0) {
    return;
  }

  const npmLock = parseJsonObject(readFileSync(npmLockPath, "utf8"));
  const disabled = disableDependencyShrinkwrapOverrideConflictSources(npmLock, overrideRules);
  if (disabled.length === 0) {
    const violations = collectOverrideViolations(npmLock, overrideRules);
    if (violations.length > 0) {
      throw new Error(
        `generated package-lock.json violates workspace overrides: ${describeOverrideViolations(violations)}`,
      );
    }
    return;
  }

  // npm 11 ignores root overrides inside dependency-owned shrinkwraps. Mark those embedded
  // shrinkwraps as inactive, drop their cached subtree, then ask npm to recalculate this
  // package's authoritative lock with registry integrity hashes.
  writeFileSync(npmLockPath, `${JSON.stringify(npmLock, null, 2)}\n`);
  runNpm(npmInstallArgs, tempDir, env);

  const normalized = parseJsonObject(readFileSync(npmLockPath, "utf8"));
  const remaining = collectOverrideViolations(normalized, overrideRules);
  if (remaining.length > 0) {
    throw new Error(
      `generated package-lock.json violates workspace overrides after disabling ${disabled.join(", ")}: ${describeOverrideViolations(remaining)}`,
    );
  }
}

function normalizeNpmVersionDrift<T>(lockfile: T): T {
  const packages = recordAt(lockfile, "packages");
  if (!packages) {
    return lockfile;
  }
  for (const metadata of Object.values(packages)) {
    if (!isRecord(metadata)) {
      continue;
    }
    // npm versions and mutable registry metadata disagree on these package-lock
    // fields. None affect resolution, so keep generated npm locks stable.
    delete metadata.deprecated;
    delete metadata.libc;
    if (metadata.peer === true) {
      delete metadata.peer;
    }
  }
  return lockfile;
}

export function createNpmPackageLockInstallStrategyArgs(
  options: Pick<NpmLockOptions, "installStrategy"> = {},
) {
  const installStrategy = options.installStrategy;
  if (installStrategy === undefined || installStrategy === null || installStrategy === "") {
    return [];
  }
  if (!["hoisted", "nested", "shallow", "linked"].includes(installStrategy)) {
    throw new Error(`invalid npm package-lock install strategy: ${installStrategy}`);
  }
  return [`--install-strategy=${installStrategy}`];
}

export function generateNpmPackageLock(packageDir: string, options: NpmLockOptions = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-npm-lock-"));
  try {
    const env = options.env ?? process.env;
    const packageJson = parseJsonObject(
      readFileSync(path.join(packageDir, "package.json"), "utf8"),
    );
    const npmLockOverrides = readNpmLockOverrides();
    const peerResolutionArgs = shouldUseLegacyPeerDepsForNpmLock(packageJson)
      ? ["--legacy-peer-deps"]
      : [];
    const npmInstallArgs = [
      "install",
      "--package-lock-only",
      ...createNpmPackageLockInstallStrategyArgs(options),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...peerResolutionArgs,
    ];
    writeFileSync(
      path.join(tempDir, "package.json"),
      `${JSON.stringify(packageJsonForNpmLock(packageJson, npmLockOverrides), null, 2)}\n`,
    );
    copyLocalFileDependencies(packageJson, packageDir, tempDir);
    runNpm(npmInstallArgs, tempDir, env);
    normalizeNpmLockOverrides(tempDir, npmLockOverrides, npmInstallArgs, env);
    const generated = normalizeNpmVersionDrift(
      applyPackageExtensionPeerMetadata(
        parseJsonObject(readFileSync(path.join(tempDir, "package-lock.json"), "utf8")),
      ),
    );
    assertNpmLockMatchesPnpmLock(generated);
    return `${JSON.stringify(generated, null, 2)}\n`;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function collectPnpmLockViolations(
  npmLock: unknown,
  pnpmLockPackages = readPnpmLockPackages(),
  pnpmLockIntegrities = readPnpmLockPackageIntegrities(),
) {
  const packages = recordAt(npmLock, "packages");
  if (!packages) {
    return [];
  }
  const violations: Array<{
    actualIntegrity?: string;
    expectedIntegrities?: string[];
    packageKey: string;
    path: string;
  }> = [];
  for (const [lockPath, metadata] of Object.entries(packages)) {
    if (
      lockPath === "" ||
      !isRecord(metadata) ||
      typeof metadata.version !== "string" ||
      !metadata.version ||
      metadata.link === true
    ) {
      continue;
    }
    const packageName =
      typeof metadata.name === "string"
        ? metadata.name
        : parseLockPackagePath(lockPath).at(-1)?.name;
    if (!packageName) {
      continue;
    }
    const packageKey = `${packageName}@${metadata.version}`;
    if (!pnpmLockPackages.has(packageKey)) {
      violations.push({ path: lockPath, packageKey });
      continue;
    }
    const expectedIntegrities = [...(pnpmLockIntegrities.get(packageKey) ?? [])].toSorted(
      (left, right) => left.localeCompare(right),
    );
    if (
      expectedIntegrities.length > 0 &&
      (typeof metadata.integrity !== "string" || !expectedIntegrities.includes(metadata.integrity))
    ) {
      violations.push({
        path: lockPath,
        packageKey,
        actualIntegrity: typeof metadata.integrity === "string" ? metadata.integrity : "<missing>",
        expectedIntegrities,
      });
    }
  }
  return violations;
}

function assertNpmLockMatchesPnpmLock(npmLock: unknown) {
  const violations = collectPnpmLockViolations(npmLock);
  if (violations.length === 0) {
    return;
  }
  const examples = violations
    .slice(0, 5)
    .map((violation) =>
      violation.expectedIntegrities
        ? `${violation.path} integrity ${violation.actualIntegrity}, expected ${violation.expectedIntegrities.join(" or ")}`
        : `${violation.path} locked ${violation.packageKey}`,
    )
    .join("; ");
  throw new Error(`generated package-lock.json violates pnpm-lock.yaml: ${examples}`);
}

function packageLabel(packageDir: string) {
  const relative = path.relative(ROOT_DIR, packageDir);
  return relative ? relative.replaceAll(path.sep, "/") : ".";
}

function listManagedNpmLockPackageDirs() {
  // npm locks are generated on demand for every publishable package, but never committed.
  return ["extensions", "packages"]
    .flatMap((parentDir) =>
      readdirSync(path.join(ROOT_DIR, parentDir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.posix.join(parentDir, entry.name)),
    )
    .filter((packageDir) => {
      const packageJsonPath = path.join(ROOT_DIR, packageDir, "package.json");
      if (!existsSync(packageJsonPath)) {
        return false;
      }
      const packageJson: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      return recordAt(recordAt(packageJson, "openclaw"), "release")?.publishToNpm === true;
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function npmLockPackageDirsForChangedPaths(changedPaths: string[]) {
  const packageDirs = new Set<string>();
  const managedNpmLockPackageDirs = new Set(listManagedNpmLockPackageDirs());
  let hasAmbiguousDependencyPolicyChange = false;
  let hasLockfileChange = false;

  for (const rawPath of changedPaths) {
    const changedPath = rawPath
      .trim()
      .replaceAll("\\", "/")
      .replace(/^\.\/+/u, "");
    if (!changedPath) {
      continue;
    }
    if (changedPath === "package.json") {
      packageDirs.add(ROOT_DIR);
      continue;
    }
    const workspacePackageMatch = changedPath.match(
      /^((?:extensions|packages)\/[^/]+)(?:\/.*)?\/package\.json$/u,
    );
    const workspacePackageDir = workspacePackageMatch?.[1];
    if (workspacePackageDir && managedNpmLockPackageDirs.has(workspacePackageDir)) {
      packageDirs.add(path.resolve(ROOT_DIR, workspacePackageDir));
      continue;
    }
    if (changedPath === "pnpm-lock.yaml") {
      hasLockfileChange = true;
      continue;
    }
    if (
      changedPath === "pnpm-workspace.yaml" ||
      changedPath === "scripts/generate-npm-package-lock.mts"
    ) {
      hasAmbiguousDependencyPolicyChange = true;
    }
  }

  if (hasAmbiguousDependencyPolicyChange || hasLockfileChange) {
    return [ROOT_DIR, ...listManagedNpmLockPackageDirs().map((dir) => path.resolve(ROOT_DIR, dir))];
  }
  return [...packageDirs].toSorted((left, right) =>
    packageLabel(left).localeCompare(packageLabel(right)),
  );
}

/** @internal Directly tested script implementation detail. */
export function resolvePackageDirs(args: string[]) {
  const packageDirs: string[] = [];
  const all = args.includes("--all");
  const plugins = args.includes("--plugins");
  const changed = args.includes("--changed");
  const staged = args.includes("--staged");
  const packageDirIndex = args.indexOf("--package-dir");
  const baseIndex = args.indexOf("--base");
  const headIndex = args.indexOf("--head");
  const jobsIndex = args.indexOf("--jobs");
  if (packageDirIndex !== -1 && (all || plugins || changed)) {
    throw new Error("--package-dir cannot be combined with --all, --plugins, or --changed.");
  }
  if ([all, plugins, changed].filter(Boolean).length > 1) {
    throw new Error("--all, --plugins, and --changed cannot be combined.");
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--all" || arg === "--plugins" || arg === "--changed" || arg === "--staged") {
      continue;
    }
    if (arg === "--package-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--package-dir requires a package directory.");
      }
      packageDirs.push(path.resolve(ROOT_DIR, value));
      index += 1;
      continue;
    }
    if (arg === "--base" || arg === "--head") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a git ref.`);
      }
      index += 1;
      continue;
    }
    if (arg === "--jobs") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--jobs requires a positive integer.");
      }
      index += 1;
      continue;
    }
    throw new Error(usage());
  }

  if (!changed && (baseIndex !== -1 || headIndex !== -1 || staged)) {
    throw new Error("--base, --head, and --staged require --changed.");
  }
  const jobs = resolveNpmLockJobs(jobsIndex === -1 ? undefined : args[jobsIndex + 1]);

  if (all) {
    return {
      jobs,
      packageDirs: [
        ROOT_DIR,
        ...listManagedNpmLockPackageDirs().map((dir) => path.resolve(ROOT_DIR, dir)),
      ],
    };
  }
  if (plugins) {
    return {
      jobs,
      packageDirs: listManagedNpmLockPackageDirs().map((dir) => path.resolve(ROOT_DIR, dir)),
    };
  }
  if (changed) {
    const base = baseIndex === -1 ? "origin/main" : args[baseIndex + 1];
    const head = headIndex === -1 ? "HEAD" : args[headIndex + 1];
    if (!base || !head) {
      throw new Error("--base and --head require git refs.");
    }
    const changedPaths = staged
      ? listStagedChangedPaths()
      : listChangedPathsFromGit({
          base,
          head,
        });
    return {
      jobs,
      packageDirs: npmLockPackageDirsForChangedPaths(changedPaths),
    };
  }
  return {
    jobs,
    packageDirs: packageDirs.length > 0 ? packageDirs : [ROOT_DIR],
  };
}

function checkPackage(packageDir: string) {
  generateNpmPackageLock(packageDir);
  return `${packageLabel(packageDir)}: npm package lock validated.`;
}

/** @internal Directly tested script implementation detail. */
export function resolveNpmLockJobs(
  rawValue: unknown,
  env: NodeJS.ProcessEnv = process.env,
  fallback = NPM_LOCK_DEFAULT_JOBS,
) {
  const raw = rawValue ?? env.OPENCLAW_NPM_LOCK_JOBS ?? String(fallback);
  const rawText =
    typeof raw === "string" || typeof raw === "number" || typeof raw === "bigint"
      ? String(raw)
      : "";
  const jobs = readPositiveIntEnv("OPENCLAW_NPM_LOCK_JOBS", rawText, {
    OPENCLAW_NPM_LOCK_JOBS: rawText,
  });
  if (jobs > NPM_LOCK_MAX_JOBS) {
    throw new Error(`invalid OPENCLAW_NPM_LOCK_JOBS: ${rawText}; maximum is ${NPM_LOCK_MAX_JOBS}`);
  }
  return jobs;
}

async function runPackageWorker(packageDir: string) {
  return await new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        kind: NPM_LOCK_WORKER_KIND,
        packageDir,
      },
    });
    worker.once("message", (message: unknown) => {
      if (!isRecord(message)) {
        reject(new Error("npm-lock worker returned an invalid response"));
      } else if (typeof message.error === "string") {
        reject(new Error(message.error));
      } else {
        resolve(typeof message.output === "string" ? message.output : "");
      }
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`${packageLabel(packageDir)}: npm-lock worker exited ${code}`));
      }
    });
  });
}

async function checkPackages({ jobs, packageDirs }: ReturnType<typeof resolvePackageDirs>) {
  const outcomes = await pMap(
    packageDirs,
    async (packageDir) => {
      try {
        const output = jobs === 1 ? checkPackage(packageDir) : await runPackageWorker(packageDir);
        return { output };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    { concurrency: jobs, stopOnError: false },
  );

  const errors: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.error) {
      errors.push(outcome.error);
    } else {
      process.stdout.write(`${outcome.output}\n`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

async function main() {
  const { jobs, packageDirs } = resolvePackageDirs(process.argv.slice(2));
  if (packageDirs.length === 0) {
    process.stdout.write("No npm-lock package changes detected.\n");
    return;
  }
  const effectiveJobs = Math.min(jobs, packageDirs.length);
  process.stdout.write(
    `Validating ${packageDirs.length} npm package lock${packageDirs.length === 1 ? "" : "s"} with ${effectiveJobs} job${effectiveJobs === 1 ? "" : "s"}.\n`,
  );
  await checkPackages({ jobs: effectiveJobs, packageDirs });
}

if (!isMainThread && workerData?.kind === NPM_LOCK_WORKER_KIND) {
  const sendToParent = parentPort?.postMessage.bind(parentPort);
  try {
    const output = checkPackage(workerData.packageDir);
    sendToParent?.({ output });
  } catch (error) {
    sendToParent?.({ error: error instanceof Error ? error.message : String(error) });
  }
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(handleMainError);
}

function handleMainError(error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

/** @internal Directly tested and shared repository-script contracts. */
export {
  // Test-facing helpers cover lockfile normalization, override merging, and
  // changed-package detection without invoking npm.
  collectOverrideViolations,
  collectPnpmLockViolations,
  disableDependencyShrinkwrapOverrideConflictSources,
  exactOverrideRulesFromOverrides,
  exactVersionFromOverrideSpec,
  mergeOverrides,
  normalizeOverrides,
  applyPackageExtensionPeerMetadata,
  normalizeNpmVersionDrift,
  packageJsonForNpmLock,
  pnpmLockOverrideVersionForVersions,
  resolvePnpmLockOverridePlan,
  parsePnpmPackageKey,
  parseLockPackagePath,
  readNpmLockOverrides,
  shouldUseLegacyPeerDepsForNpmLock,
  npmLockPackageDirsForChangedPaths,
};
