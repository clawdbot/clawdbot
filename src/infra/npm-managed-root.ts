import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import type { NpmSpecResolution } from "./install-source-utils.js";
import { readJson, readJsonIfExists, writeJson } from "./json-files.js";
import type { ParsedRegistryNpmSpec } from "./npm-registry-spec.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";
import { createSafeNpmInstallArgs, createSafeNpmInstallEnv } from "./safe-package-install.js";

type ManagedNpmRootManifest = {
  private?: boolean;
  dependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
  [key: string]: unknown;
};

type HostPackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
  peerDependencies?: Record<string, string>;
};

type ManagedNpmRootOpenClawMetadata = {
  managedOverrides?: string[];
  managedPeerDependencies?: string[];
  [key: string]: unknown;
};

export type ManagedNpmRootPeerDependencySnapshot = {
  dependencies: Record<string, string>;
  managedPeerDependencies: string[];
};

export type ManagedNpmRootInstalledDependency = {
  version?: string;
  integrity?: string;
  resolved?: string;
};

type ManagedNpmRootLockfile = {
  packages?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  [key: string]: unknown;
};

type ManagedNpmRootLogger = {
  warn?: (message: string) => void;
};

type ManagedNpmRootRunCommand = typeof runCommandWithTimeout;

type ManagedNpmRootOpenClawHostState = "none" | "managed-active-host" | "linked-active-host";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readDependencyRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const dependencies: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      dependencies[key] = raw;
    }
  }
  return dependencies;
}

function isSafePackageName(name: string): boolean {
  if (name.startsWith("@")) {
    const parts = name.split("/");
    return (
      parts.length === 2 && parts.every((part) => part.length > 0 && part !== "." && part !== "..")
    );
  }
  return (
    name.length > 0 && !name.includes("/") && !name.includes("\\") && name !== "." && name !== ".."
  );
}

function isManagedNpmRootHostPeerPackageName(name: string): boolean {
  return name === "openclaw";
}

function readOverrideRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  const overrides: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key.trim()) {
      overrides[key] = raw;
    }
  }
  return overrides;
}

function readManagedOverrideKeys(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.managedOverrides)) {
    return [];
  }
  return value.managedOverrides.filter((key): key is string => typeof key === "string");
}

function readManagedPeerDependencyKeys(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.managedPeerDependencies)) {
    return [];
  }
  return value.managedPeerDependencies.filter((key): key is string => typeof key === "string");
}

function buildManagedOpenClawMetadata(params: {
  current: unknown;
  managedOverrideKeys: string[];
  managedPeerDependencyKeys?: string[];
}): ManagedNpmRootOpenClawMetadata | undefined {
  const metadata: ManagedNpmRootOpenClawMetadata = isRecord(params.current)
    ? { ...params.current }
    : {};
  if (params.managedOverrideKeys.length > 0) {
    metadata.managedOverrides = params.managedOverrideKeys;
  } else {
    delete metadata.managedOverrides;
  }
  const managedPeerDependencyKeys = params.managedPeerDependencyKeys;
  if (managedPeerDependencyKeys && managedPeerDependencyKeys.length > 0) {
    metadata.managedPeerDependencies = managedPeerDependencyKeys;
  } else if (managedPeerDependencyKeys) {
    delete metadata.managedPeerDependencies;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

async function readManagedNpmRootManifest(filePath: string): Promise<ManagedNpmRootManifest> {
  const parsed = await readJsonIfExists<unknown>(filePath);
  return isRecord(parsed) ? { ...parsed } : {};
}

function readHostDependencySpec(
  manifest: HostPackageManifest,
  packageName: string,
): string | undefined {
  return (
    manifest.dependencies?.[packageName] ??
    manifest.optionalDependencies?.[packageName] ??
    manifest.peerDependencies?.[packageName] ??
    manifest.devDependencies?.[packageName]
  );
}

function resolveHostOverrideReferences(value: unknown, manifest: HostPackageManifest): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    return readHostDependencySpec(manifest, value.slice(1)) ?? value;
  }
  if (!isRecord(value)) {
    return value;
  }
  const resolved: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    resolved[key] = resolveHostOverrideReferences(nested, manifest);
  }
  return resolved;
}

function isUnsupportedManagedNpmOverride(value: unknown): boolean {
  return typeof value === "string" && value.trim().startsWith("npm:");
}

function filterUnsupportedManagedNpmRootOverrides(value: unknown): Record<string, unknown> {
  const overrides = readOverrideRecord(value);
  const filtered: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(overrides)) {
    if (isUnsupportedManagedNpmOverride(raw)) {
      continue;
    }
    if (isRecord(raw)) {
      const nested = filterUnsupportedManagedNpmRootOverrides(raw);
      if (Object.keys(nested).length > 0) {
        filtered[key] = nested;
      }
      continue;
    }
    filtered[key] = raw;
  }
  return filtered;
}

export async function readOpenClawManagedNpmRootOverrides(params?: {
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
  packageRoot?: string | null;
}): Promise<Record<string, unknown>> {
  const packageRoot =
    params?.packageRoot ??
    resolveOpenClawPackageRootSync({
      argv1: params?.argv1 ?? process.argv[1],
      moduleUrl: params?.moduleUrl ?? import.meta.url,
      cwd: params?.cwd ?? process.cwd(),
    });
  if (!packageRoot) {
    return {};
  }
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as unknown;
    if (!isRecord(manifest)) {
      return {};
    }
    const hostManifest = manifest as HostPackageManifest;
    const overrides = readOverrideRecord(hostManifest.overrides);
    return Object.fromEntries(
      Object.entries(overrides).map(([key, value]) => [
        key,
        resolveHostOverrideReferences(value, hostManifest),
      ]),
    );
  } catch {
    return {};
  }
}

export function resolveManagedNpmRootDependencySpec(params: {
  parsedSpec: ParsedRegistryNpmSpec;
  resolution: NpmSpecResolution;
}): string {
  return params.resolution.version ?? params.parsedSpec.selector ?? "latest";
}

export async function upsertManagedNpmRootDependency(params: {
  npmRoot: string;
  packageName: string;
  dependencySpec: string;
  managedOverrides?: Record<string, unknown>;
  omitUnsupportedManagedOverrides?: boolean;
}): Promise<void> {
  await fs.mkdir(params.npmRoot, { recursive: true });
  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const dependencies = readDependencyRecord(manifest.dependencies);
  const managedOverrides = params.omitUnsupportedManagedOverrides
    ? filterUnsupportedManagedNpmRootOverrides(params.managedOverrides)
    : readOverrideRecord(params.managedOverrides);
  const managedOverrideKeys = Object.keys(managedOverrides).toSorted();
  const overrides = readOverrideRecord(manifest.overrides);
  for (const key of readManagedOverrideKeys(manifest.openclaw)) {
    delete overrides[key];
  }
  Object.assign(overrides, managedOverrides);
  const openclawMetadata = buildManagedOpenClawMetadata({
    current: manifest.openclaw,
    managedOverrideKeys,
  });
  const next: ManagedNpmRootManifest = {
    ...manifest,
    private: true,
    dependencies: {
      ...dependencies,
      [params.packageName]: params.dependencySpec,
    },
  };
  if (Object.keys(overrides).length > 0) {
    next.overrides = overrides;
  } else {
    delete next.overrides;
  }
  if (openclawMetadata) {
    next.openclaw = openclawMetadata;
  } else {
    delete next.openclaw;
  }
  await writeJson(manifestPath, next, { trailingNewline: true });
}

function isOptionalPeerDependency(manifest: Record<string, unknown>, peerName: string): boolean {
  if (!isRecord(manifest.peerDependenciesMeta)) {
    return false;
  }
  const peerMetadata = manifest.peerDependenciesMeta[peerName];
  return isRecord(peerMetadata) && peerMetadata.optional === true;
}

function isDevOnlyLockPackage(value: unknown): boolean {
  return isRecord(value) && value.dev === true;
}

function readStringList(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.filter((entry): entry is string => typeof entry === "string");
  return values.length > 0 ? values : undefined;
}

function matchesNpmPlatformList(value: string | undefined, list: string[] | undefined): boolean {
  if (!list) {
    return true;
  }
  if (list.length === 1 && list[0] === "any") {
    return true;
  }
  if (!value) {
    return false;
  }
  let negated = 0;
  let matched = false;
  for (const entry of list) {
    const negate = entry.startsWith("!");
    const test = negate ? entry.slice(1) : entry;
    if (negate) {
      negated += 1;
      if (value === test) {
        return false;
      }
    } else {
      matched = matched || value === test;
    }
  }
  return matched || negated === list.length;
}

function resolveCurrentLibc(): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  const report: unknown = process.report?.getReport();
  const header = isRecord(report) ? report.header : undefined;
  if (isRecord(header) && header.glibcVersionRuntime) {
    return "glibc";
  }
  const sharedObjects = isRecord(report) ? report.sharedObjects : undefined;
  if (
    Array.isArray(sharedObjects) &&
    sharedObjects.some((file) => typeof file === "string" && file.includes("musl"))
  ) {
    return "musl";
  }
  return undefined;
}

function isUnsupportedOptionalLockPackage(value: unknown): boolean {
  if (!isRecord(value) || value.optional !== true) {
    return false;
  }
  return (
    !matchesNpmPlatformList(process.platform, readStringList(value.os)) ||
    !matchesNpmPlatformList(process.arch, readStringList(value.cpu)) ||
    !matchesNpmPlatformList(resolveCurrentLibc(), readStringList(value.libc))
  );
}

function readLockPackageName(location: string, value: unknown): string | undefined {
  if (isRecord(value)) {
    const packageName = readOptionalString(value.name);
    if (packageName) {
      return packageName;
    }
  }
  const parts = location.split("/");
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index] !== "node_modules") {
      continue;
    }
    const first = parts[index + 1];
    if (!first) {
      return undefined;
    }
    if (!first.startsWith("@")) {
      return first;
    }
    const second = parts[index + 2];
    return second ? `${first}/${second}` : undefined;
  }
  return undefined;
}

function findLockPackageVersion(params: {
  lockfile: ManagedNpmRootLockfile;
  packageName: string;
}): string | undefined {
  if (!isRecord(params.lockfile.packages)) {
    return undefined;
  }
  const preferredLocation = `node_modules/${params.packageName}`;
  const preferredPackage = params.lockfile.packages[preferredLocation];
  if (
    isRecord(preferredPackage) &&
    !isDevOnlyLockPackage(preferredPackage) &&
    !isUnsupportedOptionalLockPackage(preferredPackage)
  ) {
    const preferredVersion = readOptionalString(preferredPackage.version);
    if (preferredVersion) {
      return preferredVersion;
    }
  }
  return undefined;
}

function collectNpmLockPeerDependencyPins(params: {
  lockfile: ManagedNpmRootLockfile;
}): Record<string, string> {
  const pins = new Map<string, string>();
  const packages = isRecord(params.lockfile.packages) ? params.lockfile.packages : {};
  for (const [location, value] of Object.entries(packages).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (
      location === "" ||
      !isRecord(value) ||
      isDevOnlyLockPackage(value) ||
      isUnsupportedOptionalLockPackage(value)
    ) {
      continue;
    }
    const packageName = readLockPackageName(location, value);
    if (packageName && isManagedNpmRootHostPeerPackageName(packageName)) {
      continue;
    }
    const peerDependencies = readDependencyRecord(value.peerDependencies);
    for (const [peerName, peerRange] of Object.entries(peerDependencies)) {
      if (
        isManagedNpmRootHostPeerPackageName(peerName) ||
        pins.has(peerName) ||
        !isSafePackageName(peerName)
      ) {
        continue;
      }
      const version = findLockPackageVersion({ lockfile: params.lockfile, packageName: peerName });
      if (!version && isOptionalPeerDependency(value, peerName)) {
        continue;
      }
      pins.set(peerName, version ?? peerRange);
    }
  }
  return Object.fromEntries(
    [...pins.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

async function copyPathIfExists(source: string, destination: string): Promise<void> {
  try {
    await fs.cp(source, destination, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
}

function scrubHostPeerFromLockPackage(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  let changed = false;
  if (isRecord(value.peerDependencies) && "openclaw" in value.peerDependencies) {
    const peerDependencies = { ...value.peerDependencies };
    delete peerDependencies.openclaw;
    if (Object.keys(peerDependencies).length > 0) {
      value.peerDependencies = peerDependencies;
    } else {
      delete value.peerDependencies;
    }
    changed = true;
  }
  if (isRecord(value.peerDependenciesMeta) && "openclaw" in value.peerDependenciesMeta) {
    const peerDependenciesMeta = { ...value.peerDependenciesMeta };
    delete peerDependenciesMeta.openclaw;
    if (Object.keys(peerDependenciesMeta).length > 0) {
      value.peerDependenciesMeta = peerDependenciesMeta;
    } else {
      delete value.peerDependenciesMeta;
    }
    changed = true;
  }
  return changed;
}

async function scrubHostPeerFromTempPackageLock(lockPath: string): Promise<void> {
  const parsed = await readJsonIfExists<unknown>(lockPath);
  if (!isRecord(parsed)) {
    return;
  }
  let changed = false;
  if (isRecord(parsed.packages)) {
    for (const value of Object.values(parsed.packages)) {
      changed = scrubHostPeerFromLockPackage(value) || changed;
    }
  }
  if (isRecord(parsed.dependencies)) {
    for (const value of Object.values(parsed.dependencies)) {
      changed = scrubHostPeerFromLockPackage(value) || changed;
    }
  }
  if (changed) {
    await writeJson(lockPath, parsed, { trailingNewline: true });
  }
}

function collectExistingManagedPeerDependencyPins(
  dependencies: Record<string, string>,
  previousManagedPeerDependencies: string[],
): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const packageName of previousManagedPeerDependencies) {
    const dependencySpec = dependencies[packageName];
    if (dependencySpec) {
      pins[packageName] = dependencySpec;
    }
  }
  return pins;
}

function isHostPeerResolutionFailure(
  result: Awaited<ReturnType<ManagedNpmRootRunCommand>>,
): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return /(^|[^@\w.-])openclaw(?=$|[@\s:,"'])/i.test(output);
}

function createManagedNpmPeerPlanArgs(params?: {
  force?: boolean;
  legacyPeerDeps?: boolean;
}): string[] {
  return [
    "npm",
    "install",
    "--package-lock-only",
    ...(params?.force ? ["--force"] : []),
    ...createSafeNpmInstallArgs({
      omitDev: true,
      omitPeer: true,
      legacyPeerDeps: params?.legacyPeerDeps,
      loglevel: "error",
      ignoreWorkspaces: true,
      noAudit: true,
      noFund: true,
    }).slice(1),
  ];
}

async function collectNpmResolvedManagedNpmRootPeerDependencyPins(params: {
  npmRoot: string;
  runCommand?: ManagedNpmRootRunCommand;
  timeoutMs?: number;
}): Promise<Record<string, string>> {
  const manifest = await readManagedNpmRootManifest(path.join(params.npmRoot, "package.json"));
  const dependencies = readDependencyRecord(manifest.dependencies);
  const previousManagedPeerDependencies = readManagedPeerDependencyKeys(manifest.openclaw);
  const fallbackPeerPins = collectExistingManagedPeerDependencyPins(
    dependencies,
    previousManagedPeerDependencies,
  );
  for (const packageName of previousManagedPeerDependencies) {
    delete dependencies[packageName];
  }
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-peer-plan-"));
  try {
    delete dependencies.openclaw;
    await writeJson(
      path.join(tempRoot, "package.json"),
      {
        ...manifest,
        private: true,
        dependencies,
      },
      { trailingNewline: true },
    );
    await copyPathIfExists(
      path.join(params.npmRoot, "package-lock.json"),
      path.join(tempRoot, "package-lock.json"),
    );
    const tempLockPath = path.join(tempRoot, "package-lock.json");
    await scrubHostPeerFromTempPackageLock(tempLockPath);
    await copyPathIfExists(path.join(params.npmRoot, ".npmrc"), path.join(tempRoot, ".npmrc"));
    await copyPathIfExists(
      path.join(params.npmRoot, "_openclaw-pack-archives"),
      path.join(tempRoot, "_openclaw-pack-archives"),
    );

    const command = params.runCommand ?? runCommandWithTimeout;
    const npmPeerPlanArgs = createManagedNpmPeerPlanArgs({ force: true });
    const npmPlanOptions = {
      cwd: tempRoot,
      timeoutMs: Math.max(params.timeoutMs ?? 300_000, 300_000),
      env: createSafeNpmInstallEnv(process.env, {
        legacyPeerDeps: false,
        packageLock: true,
        quiet: true,
      }),
    };
    const result = await command(npmPeerPlanArgs, npmPlanOptions);
    if (result.code !== 0) {
      if (isHostPeerResolutionFailure(result)) {
        const hostPeerFallbackArgs = createManagedNpmPeerPlanArgs({
          force: true,
          legacyPeerDeps: true,
        });
        const hostPeerFallbackOptions = {
          ...npmPlanOptions,
          env: createSafeNpmInstallEnv(process.env, {
            legacyPeerDeps: true,
            packageLock: true,
            quiet: true,
          }),
        };
        const hostPeerFallbackResult = await command(hostPeerFallbackArgs, hostPeerFallbackOptions);
        if (hostPeerFallbackResult.code === 0) {
          const lockfile = await readManagedNpmRootManifest(tempLockPath);
          return collectNpmLockPeerDependencyPins({ lockfile });
        }
      }
      return fallbackPeerPins;
    }
    const lockfile = await readManagedNpmRootManifest(tempLockPath);
    return collectNpmLockPeerDependencyPins({ lockfile });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export async function readManagedNpmRootPeerDependencySnapshot(params: {
  npmRoot: string;
}): Promise<ManagedNpmRootPeerDependencySnapshot> {
  const manifest = await readManagedNpmRootManifest(path.join(params.npmRoot, "package.json"));
  const dependencies = readDependencyRecord(manifest.dependencies);
  const managedPeerDependencies = readManagedPeerDependencyKeys(manifest.openclaw).toSorted();
  const dependencySnapshot: Record<string, string> = {};
  for (const packageName of managedPeerDependencies) {
    const dependencySpec = dependencies[packageName];
    if (dependencySpec) {
      dependencySnapshot[packageName] = dependencySpec;
    }
  }
  return {
    dependencies: dependencySnapshot,
    managedPeerDependencies,
  };
}

export async function restoreManagedNpmRootPeerDependencySnapshot(params: {
  npmRoot: string;
  snapshot: ManagedNpmRootPeerDependencySnapshot;
}): Promise<void> {
  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const dependencies = readDependencyRecord(manifest.dependencies);
  for (const packageName of readManagedPeerDependencyKeys(manifest.openclaw)) {
    delete dependencies[packageName];
  }
  Object.assign(dependencies, params.snapshot.dependencies);
  const managedOverrideKeys = readManagedOverrideKeys(manifest.openclaw).toSorted();
  const openclawMetadata = buildManagedOpenClawMetadata({
    current: manifest.openclaw,
    managedOverrideKeys,
    managedPeerDependencyKeys: params.snapshot.managedPeerDependencies.toSorted(),
  });
  const next: ManagedNpmRootManifest = {
    ...manifest,
    private: true,
    dependencies,
  };
  if (openclawMetadata) {
    next.openclaw = openclawMetadata;
  } else {
    delete next.openclaw;
  }
  await writeJson(manifestPath, next, { trailingNewline: true });
}

export async function syncManagedNpmRootPeerDependencies(params: {
  npmRoot: string;
  managedOverrides?: Record<string, unknown>;
  omitUnsupportedManagedOverrides?: boolean;
  runCommand?: ManagedNpmRootRunCommand;
  timeoutMs?: number;
}): Promise<boolean> {
  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const dependencies = readDependencyRecord(manifest.dependencies);
  const previousManagedPeerDependencies = readManagedPeerDependencyKeys(manifest.openclaw);
  const previousManagedPeerDependencySet = new Set(previousManagedPeerDependencies);
  const peerPins = await collectNpmResolvedManagedNpmRootPeerDependencyPins({
    npmRoot: params.npmRoot,
    runCommand: params.runCommand,
    timeoutMs: params.timeoutMs,
  });
  const nextDependencies = { ...dependencies };
  for (const packageName of previousManagedPeerDependencies) {
    if (!Object.hasOwn(peerPins, packageName)) {
      delete nextDependencies[packageName];
    }
  }
  for (const [packageName, dependencySpec] of Object.entries(peerPins)) {
    nextDependencies[packageName] = dependencies[packageName] ?? dependencySpec;
  }

  const managedOverrides = params.omitUnsupportedManagedOverrides
    ? filterUnsupportedManagedNpmRootOverrides(params.managedOverrides)
    : readOverrideRecord(params.managedOverrides);
  const managedOverrideKeys = Object.keys(managedOverrides).toSorted();
  const overrides = readOverrideRecord(manifest.overrides);
  for (const key of readManagedOverrideKeys(manifest.openclaw)) {
    delete overrides[key];
  }
  Object.assign(overrides, managedOverrides);
  const managedPeerDependencyKeys = Object.keys(peerPins)
    .filter(
      (packageName) =>
        previousManagedPeerDependencySet.has(packageName) ||
        !Object.hasOwn(dependencies, packageName),
    )
    .toSorted();
  const openclawMetadata = buildManagedOpenClawMetadata({
    current: manifest.openclaw,
    managedOverrideKeys,
    managedPeerDependencyKeys,
  });
  const next: ManagedNpmRootManifest = {
    ...manifest,
    private: true,
    dependencies: nextDependencies,
  };
  if (Object.keys(overrides).length > 0) {
    next.overrides = overrides;
  } else {
    delete next.overrides;
  }
  if (openclawMetadata) {
    next.openclaw = openclawMetadata;
  } else {
    delete next.openclaw;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(manifest);
  if (changed) {
    await writeJson(manifestPath, next, { trailingNewline: true });
  }
  return changed;
}

export async function repairManagedNpmRootOpenClawPeer(params: {
  npmRoot: string;
  packageRoot?: string | null;
  timeoutMs?: number;
  logger?: ManagedNpmRootLogger;
  runCommand?: ManagedNpmRootRunCommand;
}): Promise<boolean> {
  await fs.mkdir(params.npmRoot, { recursive: true });

  const activeHostState = await readManagedNpmRootOpenClawHostState({
    npmRoot: params.npmRoot,
    packageRoot: params.packageRoot,
  });
  if (activeHostState === "managed-active-host") {
    return false;
  }

  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const dependencies = readDependencyRecord(manifest.dependencies);
  const hasManifestDependency = "openclaw" in dependencies;
  const hasLockDependency = await managedNpmRootLockfileHasOpenClawPeer(params.npmRoot);
  const hasPackageDir = await pathExists(path.join(params.npmRoot, "node_modules", "openclaw"));
  const preserveActiveHostLink = activeHostState === "linked-active-host";
  if (!hasManifestDependency && !hasLockDependency && (!hasPackageDir || preserveActiveHostLink)) {
    return false;
  }

  if (preserveActiveHostLink) {
    await scrubManagedNpmRootOpenClawPeer({
      npmRoot: params.npmRoot,
      preservePackageDir: true,
    });
    return true;
  }

  const command = params.runCommand ?? runCommandWithTimeout;
  const npmArgs = hasManifestDependency
    ? [
        "npm",
        "uninstall",
        "--loglevel=error",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "openclaw",
      ]
    : [
        "npm",
        "prune",
        "--loglevel=error",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ];
  try {
    const result = await command(npmArgs, {
      cwd: params.npmRoot,
      timeoutMs: Math.max(params.timeoutMs ?? 300_000, 300_000),
      env: createSafeNpmInstallEnv(process.env, {
        legacyPeerDeps: true,
        packageLock: true,
        quiet: true,
      }),
    });
    if (result.code !== 0) {
      params.logger?.warn?.(
        `npm ${hasManifestDependency ? "uninstall openclaw" : "prune"} failed while repairing managed npm root; falling back to direct cleanup: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  } catch (error) {
    params.logger?.warn?.(
      `npm ${hasManifestDependency ? "uninstall openclaw" : "prune"} failed while repairing managed npm root; falling back to direct cleanup: ${String(error)}`,
    );
  }

  await scrubManagedNpmRootOpenClawPeer({ npmRoot: params.npmRoot });
  return true;
}

async function readManagedNpmRootOpenClawHostState(params: {
  npmRoot: string;
  packageRoot?: string | null;
}): Promise<ManagedNpmRootOpenClawHostState> {
  const packageRoot =
    params.packageRoot === undefined
      ? resolveOpenClawPackageRootSync({
          argv1: process.argv[1],
          moduleUrl: import.meta.url,
          cwd: process.cwd(),
        })
      : params.packageRoot;
  if (!packageRoot) {
    return "none";
  }

  const managedOpenClawPackageDir = path.join(params.npmRoot, "node_modules", "openclaw");
  const [hostPackageRoot, managedPackageRoot, managedPackageStat] = await Promise.all([
    realpathIfExists(packageRoot),
    realpathIfExists(managedOpenClawPackageDir),
    lstatIfExists(managedOpenClawPackageDir),
  ]);
  if (hostPackageRoot === null || hostPackageRoot !== managedPackageRoot) {
    return "none";
  }
  return managedPackageStat?.isSymbolicLink() ? "linked-active-host" : "managed-active-host";
}

async function managedNpmRootLockfileHasOpenClawPeer(npmRoot: string): Promise<boolean> {
  const lockPath = path.join(npmRoot, "package-lock.json");
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as ManagedNpmRootLockfile;
    if (isRecord(parsed.packages)) {
      const rootPackage = parsed.packages[""];
      if (
        isRecord(rootPackage) &&
        isRecord(rootPackage.dependencies) &&
        "openclaw" in rootPackage.dependencies
      ) {
        return true;
      }
      if ("node_modules/openclaw" in parsed.packages) {
        return true;
      }
    }
    return isRecord(parsed.dependencies) && "openclaw" in parsed.dependencies;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function realpathIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.realpath(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function lstatIfExists(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return await fs
    .lstat(filePath)
    .then(() => true)
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        return false;
      }
      throw err;
    });
}

async function scrubManagedNpmRootOpenClawPeer(params: {
  npmRoot: string;
  preservePackageDir?: boolean;
}): Promise<void> {
  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const dependencies = readDependencyRecord(manifest.dependencies);
  if ("openclaw" in dependencies) {
    const { openclaw: _removed, ...nextDependencies } = dependencies;
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, private: true, dependencies: nextDependencies }, null, 2)}\n`,
      "utf8",
    );
  }

  const lockPath = path.join(params.npmRoot, "package-lock.json");
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8")) as ManagedNpmRootLockfile;
    let lockChanged = false;
    if (isRecord(parsed.packages)) {
      const rootPackage = parsed.packages[""];
      if (isRecord(rootPackage) && isRecord(rootPackage.dependencies)) {
        const dependencies = { ...rootPackage.dependencies };
        if ("openclaw" in dependencies) {
          delete dependencies.openclaw;
          parsed.packages[""] = { ...rootPackage, dependencies };
          lockChanged = true;
        }
      }
      if ("node_modules/openclaw" in parsed.packages) {
        delete parsed.packages["node_modules/openclaw"];
        lockChanged = true;
      }
    }
    if (isRecord(parsed.dependencies) && "openclaw" in parsed.dependencies) {
      const dependencies = { ...parsed.dependencies };
      delete dependencies.openclaw;
      parsed.dependencies = dependencies;
      lockChanged = true;
    }
    if (lockChanged) {
      await fs.writeFile(lockPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const openclawPackageDir = path.join(params.npmRoot, "node_modules", "openclaw");
  if (!params.preservePackageDir && (await pathExists(openclawPackageDir))) {
    await fs.rm(openclawPackageDir, { recursive: true, force: true });
  }
  const binDir = path.join(params.npmRoot, "node_modules", ".bin");
  await Promise.all(
    ["openclaw", "openclaw.cmd", "openclaw.ps1"].map((binName) =>
      fs.rm(path.join(binDir, binName), { force: true }),
    ),
  );
  await fs.rm(path.join(params.npmRoot, "node_modules", ".package-lock.json"), {
    force: true,
  });
}

export async function readManagedNpmRootInstalledDependency(params: {
  npmRoot: string;
  packageName: string;
}): Promise<ManagedNpmRootInstalledDependency | null> {
  const lockPath = path.join(params.npmRoot, "package-lock.json");
  const parsed = await readJson<unknown>(lockPath);
  if (!isRecord(parsed) || !isRecord(parsed.packages)) {
    return null;
  }
  const entry = parsed.packages[`node_modules/${params.packageName}`];
  if (!isRecord(entry)) {
    return null;
  }
  return {
    version: readOptionalString(entry.version),
    integrity: readOptionalString(entry.integrity),
    resolved: readOptionalString(entry.resolved),
  };
}

export async function removeManagedNpmRootDependency(params: {
  npmRoot: string;
  packageName: string;
}): Promise<void> {
  const manifestPath = path.join(params.npmRoot, "package.json");
  const manifest = await readManagedNpmRootManifest(manifestPath);
  const dependencies = readDependencyRecord(manifest.dependencies);
  if (!(params.packageName in dependencies)) {
    return;
  }
  const { [params.packageName]: _removed, ...nextDependencies } = dependencies;
  const next: ManagedNpmRootManifest = {
    ...manifest,
    private: true,
    dependencies: nextDependencies,
  };
  await writeJson(manifestPath, next, { trailingNewline: true });
}
