import { existsSync } from "node:fs";
import path from "node:path";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../../../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../../../infra/npm-registry-spec.js";
import {
  resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginNpmDir,
  resolvePluginInstallDir,
  resolvePluginNpmPackageDir,
} from "../../../plugins/install-paths.js";
import { resolveUserPath } from "../../../utils.js";
import type {
  BundledPluginPackageDescriptor,
  DownloadableInstallCandidate,
} from "./missing-configured-plugin-install.candidates.js";

export function forceNpmInstallRecordRepair(record: PluginInstallRecord): PluginInstallRecord {
  if (record.source !== "npm") {
    return record;
  }
  const next = { ...record };
  delete next.resolvedSpec;
  delete next.resolvedVersion;
  return next;
}

export function isInstalledRecordMissingOnDisk(
  record: PluginInstallRecord | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const installPath = record?.installPath?.trim();
  if (!installPath) {
    return true;
  }
  const resolved = resolveUserPath(installPath, env);
  return !existsSync(path.join(resolved, "package.json"));
}

export function pathsEqual(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export function resolveNpmPackageInstallPath(params: {
  packageName: string;
  npmRoot: string;
}): string {
  return resolvePluginNpmPackageDir({
    npmDir: params.npmRoot,
    packageName: params.packageName,
  });
}

export function resolveLegacyNpmPackageInstallPath(params: {
  packageName: string;
  npmRoot: string;
}): string {
  return path.join(params.npmRoot, "node_modules", ...params.packageName.split("/"));
}

function collectCandidateOfficialPackageNames(
  candidate: DownloadableInstallCandidate,
): Set<string> {
  const names = new Set<string>();
  const npmName = candidate.npmSpec ? parseRegistryNpmSpec(candidate.npmSpec)?.name : undefined;
  const clawhubName = candidate.clawhubSpec
    ? parseClawHubPluginSpec(candidate.clawhubSpec)?.name
    : undefined;
  if (npmName) {
    names.add(npmName);
  }
  if (clawhubName) {
    names.add(clawhubName);
  }
  return names;
}

function collectInstalledRecordPackageNames(record: PluginInstallRecord): Set<string> {
  const names = new Set<string>();
  if (record.source === "npm") {
    const specName = record.spec ? parseRegistryNpmSpec(record.spec)?.name : undefined;
    const resolvedSpecName = record.resolvedSpec
      ? parseRegistryNpmSpec(record.resolvedSpec)?.name
      : undefined;
    for (const value of [record.resolvedName, specName, resolvedSpecName]) {
      if (value) {
        names.add(value);
      }
    }
  }
  if (record.source === "clawhub") {
    const specName = record.spec ? parseClawHubPluginSpec(record.spec)?.name : undefined;
    for (const value of [record.clawhubPackage, specName]) {
      if (value) {
        names.add(value);
      }
    }
  }
  return names;
}

export function isTrustedOfficialInstallRecordForCandidate(params: {
  record: PluginInstallRecord | undefined;
  candidate: DownloadableInstallCandidate;
}): boolean {
  const record = params.record;
  if (!record) {
    return false;
  }
  if (record.source !== "npm" && record.source !== "clawhub") {
    return false;
  }
  if (record.source === "clawhub" && record.clawhubChannel !== "official") {
    return false;
  }
  const candidatePackageNames = collectCandidateOfficialPackageNames(params.candidate);
  if (candidatePackageNames.size === 0) {
    return false;
  }
  for (const installedPackageName of collectInstalledRecordPackageNames(record)) {
    if (candidatePackageNames.has(installedPackageName)) {
      return true;
    }
  }
  return false;
}

export function resolveSafeBrokenOfficialInstallRemovalPath(params: {
  pluginId: string;
  candidate: DownloadableInstallCandidate;
  record: PluginInstallRecord | undefined;
  env: NodeJS.ProcessEnv;
}): string | null {
  const installPath = params.record?.installPath?.trim();
  if (!installPath) {
    return null;
  }
  const resolvedInstallPath = resolveUserPath(installPath, params.env);
  try {
    const extensionsDir = resolveDefaultPluginExtensionsDir(params.env);
    const expectedExtensionPath = resolvePluginInstallDir(params.pluginId, extensionsDir);
    if (pathsEqual(resolvedInstallPath, expectedExtensionPath)) {
      return resolvedInstallPath;
    }
  } catch {
    // Ignore malformed plugin ids here; the installer will surface the real failure.
  }
  const parsedNpmSpec = params.candidate.npmSpec
    ? parseRegistryNpmSpec(params.candidate.npmSpec)
    : null;
  if (!parsedNpmSpec?.name) {
    return null;
  }
  const npmRoot = resolveDefaultPluginNpmDir(params.env);
  const expectedNpmPaths = [
    resolveNpmPackageInstallPath({
      packageName: parsedNpmSpec.name,
      npmRoot,
    }),
    resolveLegacyNpmPackageInstallPath({
      packageName: parsedNpmSpec.name,
      npmRoot,
    }),
  ];
  return expectedNpmPaths.some((expectedPath) => pathsEqual(resolvedInstallPath, expectedPath))
    ? resolvedInstallPath
    : null;
}

export function recordMatchesBundledPackage(
  record: PluginInstallRecord,
  bundled: BundledPluginPackageDescriptor,
): boolean {
  const packageName = bundled.packageName?.trim() || bundled.name?.trim();
  if (!packageName) {
    return false;
  }
  if (record.source === "npm") {
    return [record.spec, record.resolvedName, record.resolvedSpec].some(
      (value) => recordNpmPackageName(value) === packageName,
    );
  }
  if (record.source === "clawhub") {
    return [record.clawhubPackage, record.spec].some(
      (value) => recordClawHubPackageName(value) === packageName,
    );
  }
  return false;
}

function recordNpmPackageName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? parseRegistryNpmSpec(trimmed)?.name : undefined;
}

function recordClawHubPackageName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return parseClawHubPluginSpec(trimmed)?.name ?? trimmed;
}
