#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

function usage() {
  return [
    "Usage: node scripts/generate-npm-shrinkwrap.mjs [--check] [--all|--plugins|--package-dir <dir>]",
    "  default: root package only",
  ].join("\n");
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
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

function readWorkspaceOverrides() {
  const workspace = parseYaml(readFileSync(path.join(ROOT_DIR, "pnpm-workspace.yaml"), "utf8"));
  return normalizeOverrides(workspace?.overrides);
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
  return new Set(
    Object.keys(packages)
      .map((packageKey) => {
        const parsed = parsePnpmPackageKey(packageKey);
        return parsed ? `${parsed.name}@${parsed.version}` : null;
      })
      .filter((packageKey) => packageKey !== null),
  );
}

function readPnpmLockSingleVersionOverrides() {
  const lockfile = parseYaml(readFileSync(path.join(ROOT_DIR, "pnpm-lock.yaml"), "utf8"));
  const packages = lockfile?.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("pnpm-lock.yaml is missing package resolution data.");
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
  return Object.fromEntries(
    [...versionsByName.entries()]
      .filter(([, versions]) => versions.size === 1)
      .map(([name, versions]) => [name, [...versions][0]])
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function mergeOverrides(packageOverrides, workspaceOverrides, pnpmLockOverrides) {
  const merged = normalizeOverrides(packageOverrides);
  for (const [name, spec] of [
    ...Object.entries(workspaceOverrides),
    ...Object.entries(pnpmLockOverrides),
  ]) {
    const current = merged[name];
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(spec)) {
      throw new Error(
        `package.json overrides.${name} conflicts with pnpm lock policy for ${name}`,
      );
    }
    merged[name] = spec;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function readShrinkwrapOverrides() {
  return mergeOverrides(undefined, readWorkspaceOverrides(), readPnpmLockSingleVersionOverrides());
}

function packageJsonForShrinkwrap(packageJson, shrinkwrapOverrides) {
  const normalized = { ...packageJson };
  delete normalized.devDependencies;
  normalized.overrides = mergeOverrides(packageJson.overrides, shrinkwrapOverrides, {});
  return normalized;
}

function runNpm(args, cwd) {
  execFileSync(npmCommand(), args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
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

function normalizeShrinkwrapOverrides(tempDir, shrinkwrapOverrides) {
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
  runNpm(
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    tempDir,
  );

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

function generateShrinkwrap(packageDir) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-shrinkwrap-"));
  try {
    const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
    const shrinkwrapOverrides = readShrinkwrapOverrides();
    writeFileSync(
      path.join(tempDir, "package.json"),
      `${JSON.stringify(packageJsonForShrinkwrap(packageJson, shrinkwrapOverrides), null, 2)}\n`,
    );
    runNpm(
      ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      tempDir,
    );
    runNpm(["shrinkwrap", "--ignore-scripts", "--no-audit", "--no-fund"], tempDir);
    normalizeShrinkwrapOverrides(tempDir, shrinkwrapOverrides);
    const generated = normalizeNpmVersionDrift(
      JSON.parse(readFileSync(path.join(tempDir, "npm-shrinkwrap.json"), "utf8")),
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
    .map((entry) => path.join("extensions", entry.name))
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

function resolvePackageDirs(args) {
  const packageDirs = [];
  const check = args.includes("--check");
  const all = args.includes("--all");
  const plugins = args.includes("--plugins");
  const packageDirIndex = args.indexOf("--package-dir");
  if (packageDirIndex !== -1 && (all || plugins)) {
    throw new Error("--package-dir cannot be combined with --all or --plugins.");
  }
  if (all && plugins) {
    throw new Error("--all cannot be combined with --plugins.");
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check" || arg === "--all" || arg === "--plugins") {
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
    throw new Error(usage());
  }

  if (all) {
    return {
      check,
      packageDirs: [
        ROOT_DIR,
        ...listPublishablePluginPackageDirs().map((dir) => path.resolve(ROOT_DIR, dir)),
      ],
    };
  }
  if (plugins) {
    return {
      check,
      packageDirs: listPublishablePluginPackageDirs().map((dir) => path.resolve(ROOT_DIR, dir)),
    };
  }
  return { check, packageDirs: packageDirs.length > 0 ? packageDirs : [ROOT_DIR] };
}

function updateOrCheckPackage(packageDir, check) {
  const generated = generateShrinkwrap(packageDir);
  const shrinkwrapPath = shrinkwrapPathForPackage(packageDir);
  const label = packageLabel(packageDir);
  if (!check) {
    writeFileSync(shrinkwrapPath, generated);
    process.stdout.write(`${label}: npm-shrinkwrap.json updated.\n`);
    return;
  }

  let current = "";
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
  const { check, packageDirs } = resolvePackageDirs(process.argv.slice(2));
  for (const packageDir of packageDirs) {
    updateOrCheckPackage(packageDir, check);
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
  collectOverrideViolations,
  collectPnpmLockViolations,
  disableShrinkwrappedOverrideConflictSources,
  exactOverrideRulesFromOverrides,
  exactVersionFromOverrideSpec,
  normalizeNpmVersionDrift,
  parsePnpmPackageKey,
  parseLockPackagePath,
};
