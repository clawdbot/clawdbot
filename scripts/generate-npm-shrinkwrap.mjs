#!/usr/bin/env node
// Generates npm-shrinkwrap.json files that mirror pnpm lock policy for
// published packages while stripping dev-only dependency state.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { listChangedPathsFromGit, listStagedChangedPaths } from "./changed-lanes.mjs";
import { resolveNpmRunner } from "./npm-runner.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;
const NPM_SHRINKWRAP_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const NPM_SHRINKWRAP_COMMAND_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function usage() {
  return [
    "Usage: node scripts/generate-npm-shrinkwrap.mjs [--check] [--all|--plugins|--changed|--package-dir <dir>] [--base <ref>] [--head <ref>] [--staged]",
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
  return normalizeOverrideValue(overrides);
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

  // npm patch ranges can float past the pnpm lock. Pin to the newest locked patch
  // when the lock only contains one major/minor line, but keep true version forks free.
  return parsedVersions.toSorted((left, right) => right.parts.patch - left.parts.patch)[0].version;
}

function readPnpmLockVersionOverrides() {
  const lockfile = parseYaml(readFileSync(path.join(ROOT_DIR, "pnpm-lock.yaml"), "utf8"));
  const versionsByName = collectPnpmLockPackageVersions(lockfile);
  if (versionsByName.size === 0) {
    throw new Error("pnpm-lock.yaml is missing package resolution data.");
  }
  return Object.fromEntries(
    [...versionsByName.entries()]
      .map(([name, versions]) => [name, pnpmLockOverrideVersionForVersions(versions)])
      .filter(([, version]) => version !== null)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function addNestedOverride(overrides, parentSelector, dependencyName, version, conflicts) {
  const current = overrides[parentSelector];
  if (current !== undefined && !isPlainObject(current)) {
    conflicts.add(parentSelector);
    return;
  }
  const nested = current ?? {};
  const existing = nested[dependencyName];
  if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(version)) {
    conflicts.add(parentSelector);
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

function readPnpmLockScopedVersionOverrides() {
  const lockfile = parseYaml(readFileSync(path.join(ROOT_DIR, "pnpm-lock.yaml"), "utf8"));
  const versionsByName = collectPnpmLockPackageVersions(lockfile);
  if (versionsByName.size === 0) {
    throw new Error("pnpm-lock.yaml is missing package resolution data.");
  }
  const forkedPackageNames = new Set(
    [...versionsByName.entries()]
      .filter(
        ([, versions]) =>
          versions.size > 1 && pnpmLockOverrideVersionForVersions(versions) === null,
      )
      .map(([name]) => name),
  );
  if (forkedPackageNames.size === 0) {
    return {};
  }

  const overrides = {};
  const conflicts = new Set();
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
      if (!forkedPackageNames.has(dependencyName)) {
        continue;
      }
      const version = exactVersionFromOverrideSpec(String(dependencySpec));
      if (!version || !versionsByName.get(dependencyName)?.has(version)) {
        continue;
      }
      addNestedOverride(overrides, parentSelector, dependencyName, version, conflicts);
    }
  }

  for (const parentSelector of conflicts) {
    delete overrides[parentSelector];
  }
  return expandScopedOverrideChildren(overrides);
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

function readShrinkwrapOverrides() {
  return expandScopedOverrideChildren(
    mergeOverrides(
      undefined,
      readWorkspaceOverrides(),
      mergeOverrides(readPnpmLockVersionOverrides(), readPnpmLockScopedVersionOverrides(), {}),
    ),
  );
}

function packageJsonForShrinkwrap(packageJson, shrinkwrapOverrides) {
  const normalized = { ...packageJson };
  delete normalized.devDependencies;
  normalized.overrides = mergeOverrides(packageJson.overrides, shrinkwrapOverrides, {});
  return normalized;
}

/**
 * Resolves the npm command invocation used by shrinkwrap generation.
 */
export function createNpmShrinkwrapCommand(args, options = {}) {
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
 * Reads a positive integer env override for shrinkwrap subprocess limits.
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
 */
export function createNpmShrinkwrapExecOptions(invocation, cwd, env = process.env) {
  return {
    cwd,
    env: invocation.env ?? env,
    maxBuffer: readPositiveIntEnv(
      "OPENCLAW_NPM_SHRINKWRAP_COMMAND_MAX_BUFFER_BYTES",
      NPM_SHRINKWRAP_COMMAND_MAX_BUFFER_BYTES,
      env,
    ),
    shell: invocation.shell,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: readPositiveIntEnv(
      "OPENCLAW_NPM_SHRINKWRAP_COMMAND_TIMEOUT_MS",
      NPM_SHRINKWRAP_COMMAND_TIMEOUT_MS,
      env,
    ),
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  };
}

function runNpm(args, cwd) {
  const npm = createNpmShrinkwrapCommand(args);
  execFileSync(npm.command, npm.args, createNpmShrinkwrapExecOptions(npm, cwd));
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

function shouldUseLegacyPeerDepsForShrinkwrap(
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

function disableShrinkwrappedOverrideConflictSources(lockfile, overrideRules) {
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

function normalizeShrinkwrapOverrides(tempDir, shrinkwrapOverrides, npmInstallArgs) {
  const shrinkwrapPath = path.join(tempDir, "npm-shrinkwrap.json");
  const overrideRules = exactOverrideRulesFromOverrides(shrinkwrapOverrides);
  if (Object.keys(overrideRules).length === 0) {
    return;
  }

  const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
  const disabled = disableShrinkwrappedOverrideConflictSources(shrinkwrap, overrideRules);
  if (disabled.length === 0) {
    const violations = collectOverrideViolations(shrinkwrap, overrideRules);
    if (violations.length > 0) {
      throw new Error(
        `generated npm-shrinkwrap.json violates workspace overrides: ${describeOverrideViolations(violations)}`,
      );
    }
    return;
  }

  // npm ignores root overrides inside dependency-owned shrinkwraps. Mark those embedded
  // shrinkwraps as inactive, drop their cached subtree, then ask npm to recalculate this
  // package's authoritative lock with registry integrity hashes.
  writeFileSync(shrinkwrapPath, `${JSON.stringify(shrinkwrap, null, 2)}\n`);
  runNpm(npmInstallArgs, tempDir);

  const normalized = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
  const remaining = collectOverrideViolations(normalized, overrideRules);
  if (remaining.length > 0) {
    throw new Error(
      `generated npm-shrinkwrap.json violates workspace overrides after disabling ${disabled.join(", ")}: ${describeOverrideViolations(remaining)}`,
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
    // npm 11 patch releases disagree on these package-lock v3 metadata fields.
    // Keep the shrinkwrap stable across supported Node 24 patch versions.
    delete metadata.libc;
    if (metadata.peer === true) {
      delete metadata.peer;
    }
  }
  return lockfile;
}

function generateShrinkwrap(packageDir, options = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-shrinkwrap-"));
  try {
    const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
    const currentShrinkwrap = readCurrentShrinkwrap(packageDir);
    const shrinkwrapOverrides = mergeOverrides(
      options.useCurrentShrinkwrapOverrides
        ? readCurrentShrinkwrapOverrides(packageDir, declaredPackageDependencies(packageJson))
        : {},
      readShrinkwrapOverrides(),
      {},
    );
    const peerResolutionArgs = shouldUseLegacyPeerDepsForShrinkwrap(packageJson)
      ? ["--legacy-peer-deps"]
      : [];
    const npmInstallArgs = [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...peerResolutionArgs,
    ];
    writeFileSync(
      path.join(tempDir, "package.json"),
      `${JSON.stringify(packageJsonForShrinkwrap(packageJson, shrinkwrapOverrides), null, 2)}\n`,
    );
    runNpm(npmInstallArgs, tempDir);
    runNpm(
      ["shrinkwrap", "--ignore-scripts", "--no-audit", "--no-fund", ...peerResolutionArgs],
      tempDir,
    );
    normalizeShrinkwrapOverrides(tempDir, shrinkwrapOverrides, npmInstallArgs);
    const generated = restoreCurrentPnpmLockedPackages(
      normalizeNpmVersionDrift(
        applyPackageExtensionPeerMetadata(
          JSON.parse(readFileSync(path.join(tempDir, "npm-shrinkwrap.json"), "utf8")),
        ),
      ),
      currentShrinkwrap,
    );
    assertShrinkwrapMatchesPnpmLock(generated);
    return `${JSON.stringify(generated, null, 2)}\n`;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function collectPnpmLockViolations(shrinkwrap, pnpmLockPackages = readPnpmLockPackages()) {
  const packages = shrinkwrap?.packages;
  if (!packages || typeof packages !== "object") {
    return [];
  }
  const violations = [];
  for (const [lockPath, metadata] of Object.entries(packages)) {
    if (lockPath === "" || !metadata || typeof metadata !== "object" || !metadata.version) {
      continue;
    }
    const packageName = metadata.name ?? parseLockPackagePath(lockPath).at(-1)?.name;
    if (!packageName) {
      continue;
    }
    const packageKey = `${packageName}@${metadata.version}`;
    if (!pnpmLockPackages.has(packageKey)) {
      violations.push({ path: lockPath, packageKey });
    }
  }
  return violations;
}

function declaredPackageDependencies(packageJson) {
  const dependencies = new Set();
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const values = packageJson?.[key];
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      continue;
    }
    for (const dependencyName of Object.keys(values)) {
      dependencies.add(dependencyName);
    }
  }
  return dependencies;
}

function packageNameForLockPath(lockPath) {
  return parseLockPackagePath(lockPath).at(-1)?.name;
}

function dependencyCandidatePaths(parentLockPath, dependencyName) {
  const candidates = new Set();
  if (parentLockPath) {
    candidates.add(`${parentLockPath}/node_modules/${dependencyName}`);
  }

  let current = parentLockPath;
  while (current) {
    const nestedNodeModulesIndex = current.lastIndexOf("/node_modules/");
    if (nestedNodeModulesIndex === -1) {
      candidates.add(`node_modules/${dependencyName}`);
      break;
    }
    const ancestorPackagePath = current.slice(0, nestedNodeModulesIndex);
    candidates.add(`${ancestorPackagePath}/node_modules/${dependencyName}`);
    current = ancestorPackagePath;
  }
  if (!parentLockPath) {
    candidates.add(`node_modules/${dependencyName}`);
  }
  return [...candidates];
}

function resolveShrinkwrapDependency(packages, parentLockPath, dependencyName) {
  for (const candidatePath of dependencyCandidatePaths(parentLockPath, dependencyName)) {
    const candidate = packages[candidatePath];
    if (candidate?.version) {
      return {
        path: candidatePath,
        version: candidate.version,
      };
    }
  }
  return null;
}

function collectCurrentShrinkwrapOverrides(
  shrinkwrap,
  declaredDependencies = new Set(),
  pnpmLockPackages = readPnpmLockPackages(),
) {
  const packages = shrinkwrap?.packages;
  if (!packages || typeof packages !== "object") {
    return {};
  }
  const versionsByName = new Map();
  for (const [lockPath, metadata] of Object.entries(packages)) {
    if (lockPath === "" || !metadata || typeof metadata !== "object" || !metadata.version) {
      continue;
    }
    const packageName = metadata.name ?? packageNameForLockPath(lockPath);
    if (
      !packageName ||
      declaredDependencies.has(packageName) ||
      !pnpmLockPackages.has(`${packageName}@${metadata.version}`)
    ) {
      continue;
    }
    const versions = versionsByName.get(packageName) ?? new Set();
    versions.add(metadata.version);
    versionsByName.set(packageName, versions);
  }

  const overrides = Object.fromEntries(
    [...versionsByName.entries()]
      .filter(([, versions]) => versions.size === 1)
      .map(([name, versions]) => [name, [...versions][0]])
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
  const forkedPackageNames = new Set(
    [...versionsByName.entries()].filter(([, versions]) => versions.size > 1).map(([name]) => name),
  );
  const conflicts = new Set();
  for (const [lockPath, metadata] of Object.entries(packages)) {
    if (lockPath === "" || !metadata || typeof metadata !== "object" || !metadata.version) {
      continue;
    }
    const parentName = metadata.name ?? packageNameForLockPath(lockPath);
    const dependencies = metadata.dependencies;
    if (
      !parentName ||
      !dependencies ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies)
    ) {
      continue;
    }
    const parentSelector = `${parentName}@${metadata.version}`;
    for (const dependencyName of Object.keys(dependencies)) {
      if (!forkedPackageNames.has(dependencyName)) {
        continue;
      }
      const resolved = resolveShrinkwrapDependency(packages, lockPath, dependencyName);
      if (!resolved || !pnpmLockPackages.has(`${dependencyName}@${resolved.version}`)) {
        continue;
      }
      addNestedOverride(overrides, parentSelector, dependencyName, resolved.version, conflicts);
    }
  }
  for (const parentSelector of conflicts) {
    delete overrides[parentSelector];
  }
  return expandScopedOverrideChildren(overrides);
}

function readCurrentShrinkwrapOverrides(
  packageDir,
  declaredDependencies = new Set(),
  pnpmLockPackages = readPnpmLockPackages(),
) {
  try {
    return collectCurrentShrinkwrapOverrides(
      JSON.parse(readFileSync(shrinkwrapPathForPackage(packageDir), "utf8")),
      declaredDependencies,
      pnpmLockPackages,
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function readCurrentShrinkwrap(packageDir) {
  try {
    return JSON.parse(readFileSync(shrinkwrapPathForPackage(packageDir), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isStablePatchDrift(generatedVersion, currentVersion) {
  const generatedParts = stableVersionParts(generatedVersion);
  const currentParts = stableVersionParts(currentVersion);
  return (
    generatedParts !== null &&
    currentParts !== null &&
    generatedParts.major === currentParts.major &&
    generatedParts.minor === currentParts.minor &&
    generatedParts.patch !== currentParts.patch
  );
}

function compareStableVersions(leftVersion, rightVersion) {
  const left = stableVersionParts(leftVersion);
  const right = stableVersionParts(rightVersion);
  if (!left || !right) {
    return null;
  }
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function versionSatisfiesSimpleSpec(version, spec) {
  const normalized = typeof spec === "string" ? spec.trim() : "";
  if (normalized === "" || normalized === "*") {
    return true;
  }
  const match = normalized.match(/^(?<operator>\^|~|>=)?(?<version>\d+\.\d+\.\d+)$/u);
  if (!match?.groups) {
    return normalized === version;
  }
  const minimumVersion = match.groups.version;
  const comparison = compareStableVersions(version, minimumVersion);
  if (comparison === null || comparison < 0) {
    return false;
  }
  const candidate = stableVersionParts(version);
  const minimum = stableVersionParts(minimumVersion);
  if (!candidate || !minimum) {
    return false;
  }
  switch (match.groups.operator) {
    case "^":
      return minimum.major > 0
        ? candidate.major === minimum.major
        : minimum.minor > 0
          ? candidate.major === 0 && candidate.minor === minimum.minor
          : candidate.major === 0 && candidate.minor === 0 && candidate.patch === minimum.patch;
    case "~":
      return candidate.major === minimum.major && candidate.minor === minimum.minor;
    case ">=":
      return true;
    default:
      return comparison === 0;
  }
}

function dependencySpecForLockPath(packages, lockPath, dependencyName) {
  const packagePath = parseLockPackagePath(lockPath);
  const parentPath = packagePath.at(-2)?.path ?? "";
  const parent = packages[parentPath];
  return (
    parent?.dependencies?.[dependencyName] ??
    parent?.optionalDependencies?.[dependencyName] ??
    parent?.peerDependencies?.[dependencyName] ??
    null
  );
}

function restoreCurrentPnpmLockedPackages(
  generated,
  current,
  pnpmLockPackages = readPnpmLockPackages(),
) {
  if (!current) {
    return generated;
  }
  const generatedPackages = generated?.packages;
  const currentPackages = current?.packages;
  if (
    !generatedPackages ||
    typeof generatedPackages !== "object" ||
    !currentPackages ||
    typeof currentPackages !== "object"
  ) {
    return generated;
  }

  for (const [lockPath, metadata] of Object.entries(generatedPackages)) {
    if (lockPath === "" || !metadata || typeof metadata !== "object" || !metadata.version) {
      continue;
    }
    const packageName = metadata.name ?? packageNameForLockPath(lockPath);
    if (!packageName || pnpmLockPackages.has(`${packageName}@${metadata.version}`)) {
      continue;
    }

    const currentMetadata = currentPackages[lockPath];
    const currentPackageName = currentMetadata?.name ?? packageNameForLockPath(lockPath);
    if (
      !currentMetadata ||
      typeof currentMetadata !== "object" ||
      !currentMetadata.version ||
      currentPackageName !== packageName ||
      !isStablePatchDrift(metadata.version, currentMetadata.version) ||
      !versionSatisfiesSimpleSpec(
        currentMetadata.version,
        dependencySpecForLockPath(generatedPackages, lockPath, packageName),
      ) ||
      !pnpmLockPackages.has(`${packageName}@${currentMetadata.version}`)
    ) {
      continue;
    }

    // npm can float transitive patch ranges beyond pnpm's lock when one package
    // name has multiple locked major lines. Keep the existing shrinkwrap entry
    // when it still matches the canonical pnpm lock.
    generatedPackages[lockPath] = currentMetadata;
  }

  return generated;
}

function assertShrinkwrapMatchesPnpmLock(shrinkwrap) {
  const violations = collectPnpmLockViolations(shrinkwrap);
  if (violations.length === 0) {
    return;
  }
  const examples = violations
    .slice(0, 5)
    .map((violation) => `${violation.path} locked ${violation.packageKey}`)
    .join("; ");
  throw new Error(
    `generated npm-shrinkwrap.json contains package versions absent from pnpm-lock.yaml: ${examples}`,
  );
}

function packageLabel(packageDir) {
  const relative = path.relative(ROOT_DIR, packageDir);
  return relative ? relative.replaceAll(path.sep, "/") : ".";
}

function shrinkwrapPathForPackage(packageDir) {
  return path.join(packageDir, "npm-shrinkwrap.json");
}

function listPublishablePluginPackageDirs() {
  const extensionsDir = path.join(ROOT_DIR, "extensions");
  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join("extensions", entry.name))
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

function shrinkwrapPackageDirsForChangedPaths(changedPaths) {
  const packageDirs = new Set();
  const publishablePluginPackageDirs = new Set(listPublishablePluginPackageDirs());
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
    if (changedPath === "package.json" || changedPath === "npm-shrinkwrap.json") {
      packageDirs.add(ROOT_DIR);
      continue;
    }
    const extensionMatch = changedPath.match(
      /^(extensions\/[^/]+)\/(?:package\.json|npm-shrinkwrap\.json)$/u,
    );
    if (extensionMatch && publishablePluginPackageDirs.has(extensionMatch[1])) {
      packageDirs.add(path.resolve(ROOT_DIR, extensionMatch[1]));
      continue;
    }
    if (changedPath === "pnpm-lock.yaml") {
      hasLockfileChange = true;
      continue;
    }
    if (
      changedPath === "pnpm-workspace.yaml" ||
      changedPath === "scripts/generate-npm-shrinkwrap.mjs"
    ) {
      hasAmbiguousDependencyPolicyChange = true;
    }
  }

  if (hasAmbiguousDependencyPolicyChange) {
    return [
      ROOT_DIR,
      ...listPublishablePluginPackageDirs().map((dir) => path.resolve(ROOT_DIR, dir)),
    ];
  }

  if (hasLockfileChange) {
    return [
      ROOT_DIR,
      ...listPublishablePluginPackageDirs().map((dir) => path.resolve(ROOT_DIR, dir)),
    ];
  }
  return [...packageDirs].toSorted((left, right) =>
    packageLabel(left).localeCompare(packageLabel(right)),
  );
}

function normalizeChangedPath(rawPath) {
  return String(rawPath ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

function packageDependencyInputsChanged(packageDir, changedPaths) {
  const relativePackageDir = packageLabel(packageDir);
  const packageManifestPath =
    relativePackageDir === "." ? "package.json" : `${relativePackageDir}/package.json`;
  const shrinkwrapPath =
    relativePackageDir === "."
      ? "npm-shrinkwrap.json"
      : `${relativePackageDir}/npm-shrinkwrap.json`;
  return changedPaths.some((rawPath) => {
    const changedPath = normalizeChangedPath(rawPath);
    return (
      changedPath === "pnpm-lock.yaml" ||
      changedPath === "pnpm-workspace.yaml" ||
      changedPath === "scripts/generate-npm-shrinkwrap.mjs" ||
      changedPath === packageManifestPath ||
      changedPath === shrinkwrapPath
    );
  });
}

function listCheckChangedPaths() {
  try {
    return listChangedPathsFromGit({ base: "origin/main", head: "HEAD" });
  } catch {
    return [];
  }
}

function resolvePackageDirs(args) {
  const packageDirs = [];
  const check = args.includes("--check");
  const all = args.includes("--all");
  const plugins = args.includes("--plugins");
  const changed = args.includes("--changed");
  const staged = args.includes("--staged");
  const packageDirIndex = args.indexOf("--package-dir");
  const baseIndex = args.indexOf("--base");
  const headIndex = args.indexOf("--head");
  if (packageDirIndex !== -1 && (all || plugins || changed)) {
    throw new Error("--package-dir cannot be combined with --all, --plugins, or --changed.");
  }
  if ([all, plugins, changed].filter(Boolean).length > 1) {
    throw new Error("--all, --plugins, and --changed cannot be combined.");
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (
      arg === "--check" ||
      arg === "--all" ||
      arg === "--plugins" ||
      arg === "--changed" ||
      arg === "--staged"
    ) {
      continue;
    }
    if (arg === "--package-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--package-dir requires a package directory.");
      }
      packageDirs.push(path.resolve(ROOT_DIR, value));
      index += 1;
      continue;
    }
    if (arg === "--base" || arg === "--head") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a git ref.`);
      }
      index += 1;
      continue;
    }
    throw new Error(usage());
  }

  if (!changed && (baseIndex !== -1 || headIndex !== -1 || staged)) {
    throw new Error("--base, --head, and --staged require --changed.");
  }

  if (all) {
    return {
      check,
      changedPaths: check ? listCheckChangedPaths() : [],
      packageDirs: [
        ROOT_DIR,
        ...listPublishablePluginPackageDirs().map((dir) => path.resolve(ROOT_DIR, dir)),
      ],
    };
  }
  if (plugins) {
    return {
      check,
      changedPaths: check ? listCheckChangedPaths() : [],
      packageDirs: listPublishablePluginPackageDirs().map((dir) => path.resolve(ROOT_DIR, dir)),
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
      check,
      changedPaths,
      packageDirs: shrinkwrapPackageDirsForChangedPaths(changedPaths),
    };
  }
  return {
    check,
    changedPaths: check ? listCheckChangedPaths() : [],
    packageDirs: packageDirs.length > 0 ? packageDirs : [ROOT_DIR],
  };
}

function updateOrCheckPackage(packageDir, check, changedPaths = []) {
  const generated = generateShrinkwrap(packageDir, {
    useCurrentShrinkwrapOverrides:
      check && !packageDependencyInputsChanged(packageDir, changedPaths),
  });
  const shrinkwrapPath = shrinkwrapPathForPackage(packageDir);
  const label = packageLabel(packageDir);
  if (!check) {
    writeFileSync(shrinkwrapPath, generated);
    process.stdout.write(`${label}: npm-shrinkwrap.json updated.\n`);
    return;
  }

  let current;
  try {
    current = readFileSync(shrinkwrapPath, "utf8");
  } catch {
    throw new Error(
      `${label}: npm-shrinkwrap.json is missing. Run \`pnpm deps:shrinkwrap:generate\`.`,
    );
  }
  if (current !== generated) {
    throw new Error(
      `${label}: npm-shrinkwrap.json is stale. Run \`pnpm deps:shrinkwrap:generate\`.`,
    );
  }
  process.stdout.write(`${label}: npm-shrinkwrap.json is current.\n`);
}

function main() {
  const { check, changedPaths, packageDirs } = resolvePackageDirs(process.argv.slice(2));
  if (packageDirs.length === 0) {
    process.stdout.write("No shrinkwrap-managed package changes detected.\n");
    return;
  }
  for (const packageDir of packageDirs) {
    updateOrCheckPackage(packageDir, check, changedPaths);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export {
  // Test-facing helpers cover lockfile normalization, override merging, and
  // changed-package detection without invoking npm.
  collectCurrentShrinkwrapOverrides,
  collectOverrideViolations,
  collectPnpmLockViolations,
  disableShrinkwrappedOverrideConflictSources,
  exactOverrideRulesFromOverrides,
  exactVersionFromOverrideSpec,
  mergeOverrides,
  applyPackageExtensionPeerMetadata,
  normalizeNpmVersionDrift,
  packageJsonForShrinkwrap,
  packageDependencyInputsChanged,
  pnpmLockOverrideVersionForVersions,
  parsePnpmPackageKey,
  parseLockPackagePath,
  readShrinkwrapOverrides,
  restoreCurrentPnpmLockedPackages,
  shouldUseLegacyPeerDepsForShrinkwrap,
  shrinkwrapPackageDirsForChangedPaths,
};
