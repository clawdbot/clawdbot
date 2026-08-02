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
import { listChangedPathsFromGit, listStagedChangedPaths } from "./changed-lanes.mjs";
import { resolveNpmRunner } from "./npm-runner.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

function normalizeOverrideValue(value) {
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
  return String(value);
}

function normalizeOverrides(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return {};
  }
  const normalized = {};
  for (const [key, value] of Object.entries(overrides)) {
    const scopedSeparator = key.indexOf(">");
    if (scopedSeparator > 0) {
      const parentSelector = key.slice(0, scopedSeparator).trim();
      const dependencyName = key.slice(scopedSeparator + 1).trim();
      if (parentSelector && dependencyName) {
        const current = normalized[parentSelector];
        const nested = isPlainObject(current) ? current : {};
        nested[dependencyName] = normalizeOverrideValue(value);
        normalized[parentSelector] = nested;
        continue;
      }
    }
    normalized[key] = normalizeOverrideValue(value);
  }
  return normalized;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function readWorkspaceOverrides() {
  const workspace = parseYaml(readFileSync(path.join(ROOT_DIR, "pnpm-workspace.yaml"), "utf8"));
  return normalizeOverrides(workspace?.overrides);
}

function readWorkspacePackageExtensions() {
  const workspace = parseYaml(readFileSync(path.join(ROOT_DIR, "pnpm-workspace.yaml"), "utf8"));
  return workspace?.packageExtensions && typeof workspace.packageExtensions === "object"
    ? workspace.packageExtensions
    : {};
}

function parsePnpmPackageKey(packageKey) {
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
  const lockfile = parseYaml(readFileSync(path.join(ROOT_DIR, "pnpm-lock.yaml"), "utf8"));
  const packages = lockfile?.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("pnpm-lock.yaml is missing package resolution data.");
  }
  const lockPackages = new Set();
  for (const [packageKey, metadata] of Object.entries(packages)) {
    const parsed = parsePnpmPackageKey(packageKey);
    if (!parsed) {
      continue;
    }
    lockPackages.add(`${parsed.name}@${parsed.version}`);
    if (metadata && typeof metadata === "object" && typeof metadata.version === "string") {
      lockPackages.add(`${parsed.name}@${metadata.version}`);
    }
  }
  return lockPackages;
}

function readPnpmLockPackageIntegrities() {
  const lockfile = parseYaml(readFileSync(path.join(ROOT_DIR, "pnpm-lock.yaml"), "utf8"));
  const integrities = new Map();
  for (const [packageKey, metadata] of Object.entries(lockfile?.packages ?? {})) {
    const parsed = parsePnpmPackageKey(packageKey);
    const integrity = metadata?.resolution?.integrity;
    if (!parsed || typeof integrity !== "string") {
      continue;
    }
    const versions = new Set([parsed.version]);
    if (typeof metadata.version === "string") {
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

function collectPnpmLockPackageVersions(lockfile) {
  const packages = lockfile?.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    return new Map();
  }
  const versionsByName = new Map();
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

function stableVersionParts(version) {
  const match = version.match(STABLE_VERSION_PATTERN);
  return match
    ? {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
      }
    : null;
}

function pnpmLockOverrideVersionForVersions(versions) {
  const sortedVersions = [...versions].toSorted((left, right) => left.localeCompare(right));
  if (sortedVersions.length === 1) {
    return exactVersionFromOverrideSpec(sortedVersions[0]) === null ? null : sortedVersions[0];
  }

  const parsedVersions = sortedVersions.map((version) => ({
    version,
    parts: stableVersionParts(version),
  }));
  if (parsedVersions.some(({ parts }) => parts === null)) {
    return null;
  }

  const [{ parts: firstParts }] = parsedVersions;
  if (
    parsedVersions.some(
      ({ parts }) => parts.major !== firstParts.major || parts.minor !== firstParts.minor,
    )
  ) {
    return null;
  }

  return parsedVersions.toSorted((left, right) => right.parts.patch - left.parts.patch)[0].version;
}

function addNestedOverride(overrides, parentSelector, dependencyName, version, conflicts) {
  const current = overrides[parentSelector];
  if (current !== undefined && !isPlainObject(current)) {
    const parentConflicts = conflicts.get(parentSelector) ?? new Set();
    parentConflicts.add(dependencyName);
    conflicts.set(parentSelector, parentConflicts);
    return;
  }
  const nested = current ?? {};
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

function expandScopedOverrideValue(overrides, dependencyName, version, seen = new Set()) {
  const childSelector = `${dependencyName}@${version}`;
  if (seen.has(childSelector)) {
    return version;
  }
  const childOverrides = overrides[childSelector];
  if (!isPlainObject(childOverrides)) {
    return version;
  }
  const childSeen = new Set(seen);
  childSeen.add(childSelector);
  return Object.fromEntries(
    [
      [".", version],
      ...Object.entries(childOverrides).map(([nestedName, nestedVersion]) => [
        nestedName,
        typeof nestedVersion === "string"
          ? expandScopedOverrideValue(overrides, nestedName, nestedVersion, childSeen)
          : nestedVersion,
      ]),
    ].toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function expandScopedOverrideChildren(overrides) {
  return Object.fromEntries(
    Object.entries(overrides)
      .map(([parentSelector, nestedOverrides]) => [
        parentSelector,
        isPlainObject(nestedOverrides)
          ? Object.fromEntries(
              Object.entries(nestedOverrides)
                .map(([dependencyName, version]) => [
                  dependencyName,
                  typeof version === "string"
                    ? expandScopedOverrideValue(overrides, dependencyName, version)
                    : version,
                ])
                .toSorted(([left], [right]) => left.localeCompare(right)),
            )
          : typeof nestedOverrides === "string" &&
              exactVersionFromOverrideSpec(nestedOverrides) !== null
            ? isPlainObject(
                overrides[`${parentSelector}@${exactVersionFromOverrideSpec(nestedOverrides)}`],
              )
              ? expandScopedOverrideValue(
                  overrides,
                  parentSelector,
                  exactVersionFromOverrideSpec(nestedOverrides),
                )
              : nestedOverrides
            : nestedOverrides,
      ])
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function resolvePnpmLockOverridePlan(lockfile) {
  const versionsByName = collectPnpmLockPackageVersions(lockfile);
  if (versionsByName.size === 0) {
    throw new Error("pnpm-lock.yaml is missing package resolution data.");
  }
  const multiVersionPackageNames = new Set(
    [...versionsByName.entries()].filter(([, versions]) => versions.size > 1).map(([name]) => name),
  );

  const overrides = {};
  const conflicts = new Map();
  for (const [snapshotKey, snapshot] of Object.entries(lockfile?.snapshots ?? {})) {
    const parent = parsePnpmPackageKey(snapshotKey);
    const dependencies = snapshot?.dependencies;
    if (
      !parent ||
      !dependencies ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies)
    ) {
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

  const conflictingPackageNames = new Set();
  for (const dependencyNames of conflicts.values()) {
    for (const dependencyName of dependencyNames) {
      conflictingPackageNames.add(dependencyName);
    }
  }
  const versionOverrides = {};
  const scopedPackageNames = new Set();
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

  const scopedOverrides = {};
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
function mergeOverrideEntry(merged, name, spec) {
  const current = merged[name];
  if (current === undefined) {
    merged[name] = spec;
    return;
  }
  if (isPlainObject(current) && isPlainObject(spec)) {
    for (const [nestedName, nestedSpec] of Object.entries(spec)) {
      mergeOverrideEntry(current, nestedName, nestedSpec);
    }
    return;
  }
  if (
    typeof current === "string" &&
    isPlainObject(spec) &&
    typeof spec["."] === "string" &&
    exactOverrideVersionsMatch(current, spec["."])
  ) {
    merged[name] = { ".": preferredExactOverrideRootSpec(current, spec["."]) };
    for (const [nestedName, nestedSpec] of Object.entries(spec)) {
      if (nestedName === ".") {
        continue;
      }
      mergeOverrideEntry(merged[name], nestedName, nestedSpec);
    }
    return;
  }
  if (
    isPlainObject(current) &&
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

function preferredExactOverrideRootSpec(current, incoming) {
  return incoming.startsWith("npm:") ? incoming : current;
}

function exactOverrideVersionsMatch(left, right) {
  const leftVersion = exactVersionFromOverrideSpec(left);
  if (leftVersion === null || leftVersion !== exactVersionFromOverrideSpec(right)) {
    return false;
  }
  const leftAlias = parseNpmAliasOverrideSpec(left);
  const rightAlias = parseNpmAliasOverrideSpec(right);
  return !leftAlias || !rightAlias || leftAlias.name === rightAlias.name;
}

function parseNpmAliasOverrideSpec(spec) {
  if (!spec.startsWith("npm:")) {
    return null;
  }
  const versionIndex = spec.lastIndexOf("@");
  if (versionIndex <= "npm:".length) {
    return null;
  }
  return { name: spec.slice("npm:".length, versionIndex) };
}

function mergeOverrides(packageOverrides, workspaceOverrides, pnpmLockOverrides) {
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
  const lockfile = parseYaml(readFileSync(path.join(ROOT_DIR, "pnpm-lock.yaml"), "utf8"));
  const plan = resolvePnpmLockOverridePlan(lockfile);
  return expandScopedOverrideChildren(
    mergeOverrides(
      undefined,
      readWorkspaceOverrides(),
      mergeOverrides(plan.versionOverrides, plan.scopedVersionOverrides, {}),
    ),
  );
}

function packageJsonForNpmLock(packageJson, npmLockOverrides) {
  const normalized = { ...packageJson };
  delete normalized.bundleDependencies;
  delete normalized.bundledDependencies;
  delete normalized.devDependencies;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const dependencies = normalized[field];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
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

function copyLocalFileDependencies(packageJson, packageDir, tempDir) {
  const pending = [{ manifest: packageJson, packageDir }];
  const copied = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const spec of Object.values(current.manifest[field] ?? {})) {
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
            manifest: JSON.parse(readFileSync(nestedManifestPath, "utf8")),
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
export function createNpmLockCommand(args, options = {}) {
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
export function readPositiveIntEnv(name, fallback, env = process.env) {
  const text = String(env[name] ?? fallback).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  return value;
}

/**
 * Builds execFileSync options with bounded timeout and output buffer limits.
 * @internal Directly tested script implementation detail.
 */
export function createNpmLockExecOptions(invocation, cwd, env = process.env) {
  return {
    cwd,
    env: invocation.env ?? env,
    maxBuffer: readPositiveIntEnv(
      "OPENCLAW_NPM_LOCK_COMMAND_MAX_BUFFER_BYTES",
      NPM_LOCK_COMMAND_MAX_BUFFER_BYTES,
      env,
    ),
    shell: invocation.shell,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: readPositiveIntEnv(
      "OPENCLAW_NPM_LOCK_COMMAND_TIMEOUT_MS",
      NPM_LOCK_COMMAND_TIMEOUT_MS,
      env,
    ),
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  };
}

function runNpm(args, cwd, env = process.env) {
  const npm = createNpmLockCommand(args, { env });
  execFileSync(npm.command, npm.args, createNpmLockExecOptions(npm, cwd, env));
}

function packageExtensionAppliesToDependency(selector, dependencyName) {
  return selector === dependencyName || selector.startsWith(`${dependencyName}@`);
}

function packageExtensionMarksOptionalPeer(packageExtension) {
  const peerDependenciesMeta = packageExtension?.peerDependenciesMeta;
  if (
    !peerDependenciesMeta ||
    typeof peerDependenciesMeta !== "object" ||
    Array.isArray(peerDependenciesMeta)
  ) {
    return false;
  }
  return Object.values(peerDependenciesMeta).some((meta) => meta?.optional === true);
}

function shouldUseLegacyPeerDepsForNpmLock(
  packageJson,
  packageExtensions = readWorkspacePackageExtensions(),
) {
  if (
    packageExtensionMarksOptionalPeer({ peerDependenciesMeta: packageJson.peerDependenciesMeta })
  ) {
    return true;
  }
  const dependencies = Object.keys(packageJson.dependencies ?? {});
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

function applyPackageExtensionPeerMetadata(
  lockfile,
  packageExtensions = readWorkspacePackageExtensions(),
) {
  const packages = lockfile?.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    return lockfile;
  }

  for (const [lockPath, metadata] of Object.entries(packages)) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      continue;
    }
    const packageName = metadata.name ?? parseLockPackagePath(lockPath).at(-1)?.name;
    if (!packageName || !metadata.peerDependencies) {
      continue;
    }
    for (const [selector, packageExtension] of Object.entries(packageExtensions)) {
      if (!packageExtensionAppliesToDependency(selector, packageName)) {
        continue;
      }
      const peerDependenciesMeta = packageExtension?.peerDependenciesMeta;
      if (
        !peerDependenciesMeta ||
        typeof peerDependenciesMeta !== "object" ||
        Array.isArray(peerDependenciesMeta)
      ) {
        continue;
      }
      for (const [peerName, peerMeta] of Object.entries(peerDependenciesMeta)) {
        if (metadata.peerDependencies[peerName] === undefined) {
          continue;
        }
        metadata.peerDependenciesMeta ??= {};
        const existingPeerMeta = metadata.peerDependenciesMeta[peerName];
        metadata.peerDependenciesMeta[peerName] = existingPeerMeta
          ? { ...existingPeerMeta, ...peerMeta }
          : { ...peerMeta };
      }
    }
  }

  return lockfile;
}

function exactVersionFromOverrideSpec(spec) {
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

function exactOverrideRulesFromOverrides(overrides) {
  return Object.fromEntries(
    Object.entries(normalizeOverrides(overrides))
      .map(([name, spec]) => [name, exactVersionFromOverrideSpec(spec)])
      .filter((entry) => entry[1] !== null),
  );
}

function parseLockPackagePath(lockPath) {
  if (!lockPath.startsWith("node_modules/")) {
    return [];
  }
  const packages = [];
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

function collectOverrideViolations(lockfile, overrideRules) {
  const packages = lockfile?.packages;
  if (!packages || typeof packages !== "object") {
    return [];
  }
  const violations = [];
  for (const [lockPath, metadata] of Object.entries(packages)) {
    const packagePath = parseLockPackagePath(lockPath);
    const packageName = packagePath.at(-1)?.name;
    const expectedVersion = packageName ? overrideRules[packageName] : undefined;
    if (!expectedVersion || metadata?.version === expectedVersion) {
      continue;
    }
    violations.push({
      path: lockPath,
      packageName,
      actualVersion: metadata?.version ?? "<missing>",
      expectedVersion,
      packagePath,
    });
  }
  return violations;
}

function disableDependencyShrinkwrapOverrideConflictSources(lockfile, overrideRules) {
  const packages = lockfile?.packages;
  if (!packages || typeof packages !== "object") {
    return [];
  }
  /** @type {Set<string>} */
  const disabled = new Set();
  for (const violation of collectOverrideViolations(lockfile, overrideRules)) {
    const ancestors = violation.packagePath.slice(0, -1).toReversed();
    const shrinkwrappedAncestor = ancestors.find(
      (ancestor) => packages[ancestor.path]?.hasShrinkwrap === true,
    );
    if (!shrinkwrappedAncestor) {
      continue;
    }
    delete packages[shrinkwrappedAncestor.path].hasShrinkwrap;
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

function describeOverrideViolations(violations) {
  return violations
    .slice(0, 5)
    .map(
      (violation) =>
        `${violation.path} locked ${violation.actualVersion}, expected ${violation.expectedVersion}`,
    )
    .join("; ");
}

function normalizeNpmLockOverrides(tempDir, npmLockOverrides, npmInstallArgs, env) {
  const npmLockPath = path.join(tempDir, "package-lock.json");
  const overrideRules = exactOverrideRulesFromOverrides(npmLockOverrides);
  if (Object.keys(overrideRules).length === 0) {
    return;
  }

  const npmLock = JSON.parse(readFileSync(npmLockPath, "utf8"));
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

  const normalized = JSON.parse(readFileSync(npmLockPath, "utf8"));
  const remaining = collectOverrideViolations(normalized, overrideRules);
  if (remaining.length > 0) {
    throw new Error(
      `generated package-lock.json violates workspace overrides after disabling ${disabled.join(", ")}: ${describeOverrideViolations(remaining)}`,
    );
  }
}

function normalizeNpmVersionDrift(lockfile) {
  const packages = lockfile?.packages;
  if (!packages || typeof packages !== "object") {
    return lockfile;
  }
  for (const metadata of Object.values(packages)) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
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

export function createNpmPackageLockInstallStrategyArgs(options = {}) {
  const installStrategy = options.installStrategy;
  if (installStrategy === undefined || installStrategy === null || installStrategy === "") {
    return [];
  }
  if (!["hoisted", "nested", "shallow", "linked"].includes(installStrategy)) {
    throw new Error(`invalid npm package-lock install strategy: ${installStrategy}`);
  }
  return [`--install-strategy=${installStrategy}`];
}

export function generateNpmPackageLock(packageDir, options = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-npm-lock-"));
  try {
    const env = options.env ?? process.env;
    const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
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
        JSON.parse(readFileSync(path.join(tempDir, "package-lock.json"), "utf8")),
      ),
    );
    assertNpmLockMatchesPnpmLock(generated);
    return `${JSON.stringify(generated, null, 2)}\n`;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function collectPnpmLockViolations(
  npmLock,
  pnpmLockPackages = readPnpmLockPackages(),
  pnpmLockIntegrities = readPnpmLockPackageIntegrities(),
) {
  const packages = npmLock?.packages;
  if (!packages || typeof packages !== "object") {
    return [];
  }
  const violations = [];
  for (const [lockPath, metadata] of Object.entries(packages)) {
    if (
      lockPath === "" ||
      !metadata ||
      typeof metadata !== "object" ||
      !metadata.version ||
      metadata.link === true
    ) {
      continue;
    }
    const packageName = metadata.name ?? parseLockPackagePath(lockPath).at(-1)?.name;
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
        actualIntegrity: metadata.integrity ?? "<missing>",
        expectedIntegrities,
      });
    }
  }
  return violations;
}

function assertNpmLockMatchesPnpmLock(npmLock) {
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

function packageLabel(packageDir) {
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
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      return packageJson.openclaw?.release?.publishToNpm === true;
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function npmLockPackageDirsForChangedPaths(changedPaths) {
  const packageDirs = new Set();
  const managedNpmLockPackageDirs = new Set(listManagedNpmLockPackageDirs());
  let hasAmbiguousDependencyPolicyChange = false;
  let hasLockfileChange = false;

  for (const rawPath of changedPaths) {
    const changedPath = String(rawPath ?? "")
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
    if (workspacePackageMatch && managedNpmLockPackageDirs.has(workspacePackageMatch[1])) {
      packageDirs.add(path.resolve(ROOT_DIR, workspacePackageMatch[1]));
      continue;
    }
    if (changedPath === "pnpm-lock.yaml") {
      hasLockfileChange = true;
      continue;
    }
    if (
      changedPath === "pnpm-workspace.yaml" ||
      changedPath === "scripts/generate-npm-package-lock.mjs"
    ) {
      hasAmbiguousDependencyPolicyChange = true;
    }
  }

  if (hasAmbiguousDependencyPolicyChange) {
    return [ROOT_DIR, ...listManagedNpmLockPackageDirs().map((dir) => path.resolve(ROOT_DIR, dir))];
  }

  if (hasLockfileChange) {
    return [ROOT_DIR, ...listManagedNpmLockPackageDirs().map((dir) => path.resolve(ROOT_DIR, dir))];
  }
  return [...packageDirs].toSorted((left, right) =>
    packageLabel(left).localeCompare(packageLabel(right)),
  );
}

/** @internal Directly tested script implementation detail. */
export function resolvePackageDirs(args) {
  const packageDirs = [];
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

function checkPackage(packageDir) {
  generateNpmPackageLock(packageDir);
  return `${packageLabel(packageDir)}: npm package lock validated.`;
}

/** @internal Directly tested script implementation detail. */
export function resolveNpmLockJobs(rawValue, env = process.env, fallback = NPM_LOCK_DEFAULT_JOBS) {
  const raw = rawValue ?? env.OPENCLAW_NPM_LOCK_JOBS ?? String(fallback);
  const jobs = readPositiveIntEnv("OPENCLAW_NPM_LOCK_JOBS", raw, {
    OPENCLAW_NPM_LOCK_JOBS: raw,
  });
  if (jobs > NPM_LOCK_MAX_JOBS) {
    throw new Error(`invalid OPENCLAW_NPM_LOCK_JOBS: ${raw}; maximum is ${NPM_LOCK_MAX_JOBS}`);
  }
  return jobs;
}

async function runPackageWorker(packageDir) {
  return await new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        kind: NPM_LOCK_WORKER_KIND,
        packageDir,
      },
    });
    worker.once("message", (message) => {
      if (message.error) {
        reject(new Error(message.error));
      } else {
        resolve(message.output);
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

async function checkPackages({ jobs, packageDirs }) {
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

  const errors = [];
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

/** @param {unknown} error */
function handleMainError(error) {
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
