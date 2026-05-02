import fs from "node:fs";
import path from "node:path";
import {
  matchBoundaryFileOpenFailure,
  openBoundaryFile,
  openBoundaryFileSync,
} from "../infra/boundary-file-read.js";
import { resolveBoundaryPath, resolveBoundaryPathSync } from "../infra/boundary-path.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { getPackageManifestMetadata, type PackageManifest } from "./manifest.js";
import { listBuiltRuntimeEntryCandidates } from "./package-entrypoints.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

type ExtensionEntryValidation = { ok: true; exists: boolean } | { ok: false; error: string };

type RuntimeExtensionsResolution =
  | { ok: true; runtimeExtensions: string[] }
  | { ok: false; error: string };

function runtimeExtensionsLengthMismatchMessage(params: {
  runtimeExtensionsLength: number;
  extensionsLength: number;
}): string {
  return (
    `package.json openclaw.runtimeExtensions length (${params.runtimeExtensionsLength}) ` +
    `must match openclaw.extensions length (${params.extensionsLength})`
  );
}

function normalizePackageManifestStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => normalizeOptionalString(entry) ?? "").filter(Boolean);
}

function resolvePackageRuntimeExtensionEntries(params: {
  manifest: PackageManifest | null | undefined;
  extensions: readonly string[];
}): RuntimeExtensionsResolution {
  const packageManifest = getPackageManifestMetadata(params.manifest ?? undefined);
  const runtimeExtensions = normalizePackageManifestStringList(packageManifest?.runtimeExtensions);
  if (runtimeExtensions.length === 0) {
    return { ok: true, runtimeExtensions: [] };
  }
  if (runtimeExtensions.length !== params.extensions.length) {
    return {
      ok: false,
      error: runtimeExtensionsLengthMismatchMessage({
        runtimeExtensionsLength: runtimeExtensions.length,
        extensionsLength: params.extensions.length,
      }),
    };
  }
  return { ok: true, runtimeExtensions };
}

async function validatePackageExtensionEntry(params: {
  packageDir: string;
  entry: string;
  label: string;
  requireExisting: boolean;
}): Promise<ExtensionEntryValidation> {
  const absolutePath = path.resolve(params.packageDir, params.entry);
  try {
    const resolved = await resolveBoundaryPath({
      absolutePath,
      rootPath: params.packageDir,
      boundaryLabel: "plugin package directory",
    });
    if (!resolved.exists) {
      return params.requireExisting
        ? { ok: false, error: `${params.label} not found: ${params.entry}` }
        : { ok: true, exists: false };
    }
  } catch {
    return {
      ok: false,
      error: `${params.label} escapes plugin directory: ${params.entry}`,
    };
  }

  const opened = await openBoundaryFile({
    absolutePath,
    rootPath: params.packageDir,
    boundaryLabel: "plugin package directory",
  });
  if (!opened.ok) {
    return matchBoundaryFileOpenFailure(opened, {
      path: () => ({ ok: false, error: `${params.label} not found: ${params.entry}` }),
      io: () => ({ ok: false, error: `${params.label} unreadable: ${params.entry}` }),
      validation: () => ({
        ok: false,
        error: `${params.label} failed plugin directory boundary checks: ${params.entry}`,
      }),
      fallback: () => ({
        ok: false,
        error: `${params.label} failed plugin directory boundary checks: ${params.entry}`,
      }),
    });
  }
  fs.closeSync(opened.fd);
  return { ok: true, exists: true };
}

export async function validatePackageExtensionEntriesForInstall(params: {
  packageDir: string;
  extensions: string[];
  manifest: PackageManifest;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const runtimeResolution = resolvePackageRuntimeExtensionEntries({
    manifest: params.manifest,
    extensions: params.extensions,
  });
  if (!runtimeResolution.ok) {
    return runtimeResolution;
  }

  for (const [index, entry] of params.extensions.entries()) {
    const sourceEntry = await validatePackageExtensionEntry({
      packageDir: params.packageDir,
      entry,
      label: "extension entry",
      requireExisting: false,
    });
    if (!sourceEntry.ok) {
      return sourceEntry;
    }

    const runtimeEntry = runtimeResolution.runtimeExtensions[index];
    if (runtimeEntry) {
      const runtimeResult = await validatePackageExtensionEntry({
        packageDir: params.packageDir,
        entry: runtimeEntry,
        label: "runtime extension entry",
        requireExisting: true,
      });
      if (!runtimeResult.ok) {
        return runtimeResult;
      }
      continue;
    }

    if (sourceEntry.exists) {
      continue;
    }

    let foundBuiltEntry = false;
    for (const builtEntry of listBuiltRuntimeEntryCandidates(entry)) {
      const builtResult = await validatePackageExtensionEntry({
        packageDir: params.packageDir,
        entry: builtEntry,
        label: "inferred runtime extension entry",
        requireExisting: false,
      });
      if (!builtResult.ok) {
        return builtResult;
      }
      if (builtResult.exists) {
        foundBuiltEntry = true;
        break;
      }
    }

    if (!foundBuiltEntry) {
      return { ok: false, error: `extension entry not found: ${entry}` };
    }
  }

  const packageManifest = getPackageManifestMetadata(params.manifest);
  const setupEntry = normalizeOptionalString(packageManifest?.setupEntry);
  const runtimeSetupEntry = normalizeOptionalString(packageManifest?.runtimeSetupEntry);
  if (runtimeSetupEntry && !setupEntry) {
    return {
      ok: false,
      error: "package.json openclaw.runtimeSetupEntry requires openclaw.setupEntry",
    };
  }
  if (setupEntry) {
    const sourceEntry = await validatePackageExtensionEntry({
      packageDir: params.packageDir,
      entry: setupEntry,
      label: "setup entry",
      requireExisting: false,
    });
    if (!sourceEntry.ok) {
      return sourceEntry;
    }

    if (runtimeSetupEntry) {
      const runtimeResult = await validatePackageExtensionEntry({
        packageDir: params.packageDir,
        entry: runtimeSetupEntry,
        label: "runtime setup entry",
        requireExisting: true,
      });
      if (!runtimeResult.ok) {
        return runtimeResult;
      }
      return { ok: true };
    }

    if (sourceEntry.exists) {
      return { ok: true };
    }

    let foundBuiltSetupEntry = false;
    for (const builtEntry of listBuiltRuntimeEntryCandidates(setupEntry)) {
      const builtResult = await validatePackageExtensionEntry({
        packageDir: params.packageDir,
        entry: builtEntry,
        label: "inferred runtime setup entry",
        requireExisting: false,
      });
      if (!builtResult.ok) {
        return builtResult;
      }
      if (builtResult.exists) {
        foundBuiltSetupEntry = true;
        break;
      }
    }
    if (!foundBuiltSetupEntry) {
      return { ok: false, error: `setup entry not found: ${setupEntry}` };
    }
  }

  return { ok: true };
}

function resolvePackageEntrySource(params: {
  packageDir: string;
  packageRootRealPath?: string;
  entryPath: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string | null {
  const source = path.resolve(params.packageDir, params.entryPath);
  const rejectHardlinks = params.rejectHardlinks ?? true;
  const candidates = [source];
  const openCandidate = (absolutePath: string): string | null => {
    const opened = openBoundaryFileSync({
      absolutePath,
      rootPath: params.packageDir,
      ...(params.packageRootRealPath !== undefined
        ? { rootRealPath: params.packageRootRealPath }
        : {}),
      boundaryLabel: "plugin package directory",
      rejectHardlinks,
    });
    if (!opened.ok) {
      return matchBoundaryFileOpenFailure(opened, {
        path: () => null,
        io: () => {
          params.diagnostics.push({
            level: "warn",
            message: `extension entry unreadable (I/O error): ${params.entryPath}`,
            source: params.sourceLabel,
          });
          return null;
        },
        fallback: () => {
          params.diagnostics.push({
            level: "error",
            message: `extension entry escapes package directory: ${params.entryPath}`,
            source: params.sourceLabel,
          });
          return null;
        },
      });
    }
    const safeSource = opened.path;
    fs.closeSync(opened.fd);
    return safeSource;
  };
  if (!rejectHardlinks) {
    const builtCandidate = source.replace(/\.[^.]+$/u, ".js");
    if (builtCandidate !== source) {
      candidates.push(builtCandidate);
    }
  }

  for (const candidate of new Set(candidates)) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    return openCandidate(candidate);
  }

  return openCandidate(source);
}

function shouldInferBuiltRuntimeEntry(origin: PluginOrigin): boolean {
  return origin === "config" || origin === "global";
}

function resolveSafePackageEntry(params: {
  packageDir: string;
  packageRootRealPath?: string;
  entryPath: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): { relativePath: string; existingSource?: string } | null {
  const absolutePath = path.resolve(params.packageDir, params.entryPath);
  if (fs.existsSync(absolutePath)) {
    const existingSource = resolvePackageEntrySource({
      packageDir: params.packageDir,
      ...(params.packageRootRealPath !== undefined
        ? { packageRootRealPath: params.packageRootRealPath }
        : {}),
      entryPath: params.entryPath,
      sourceLabel: params.sourceLabel,
      diagnostics: params.diagnostics,
      rejectHardlinks: params.rejectHardlinks,
    });
    if (!existingSource) {
      return null;
    }
    return {
      relativePath: path.relative(params.packageDir, absolutePath).replace(/\\/g, "/"),
      existingSource,
    };
  }

  try {
    resolveBoundaryPathSync({
      absolutePath,
      rootPath: params.packageDir,
      ...(params.packageRootRealPath !== undefined
        ? { rootCanonicalPath: params.packageRootRealPath }
        : {}),
      boundaryLabel: "plugin package directory",
    });
  } catch {
    params.diagnostics.push({
      level: "error",
      message: `extension entry escapes package directory: ${params.entryPath}`,
      source: params.sourceLabel,
    });
    return null;
  }
  return { relativePath: path.relative(params.packageDir, absolutePath).replace(/\\/g, "/") };
}

function resolveExistingPackageEntrySource(params: {
  packageDir: string;
  packageRootRealPath?: string;
  entryPath: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string | null {
  const source = path.resolve(params.packageDir, params.entryPath);
  if (!fs.existsSync(source)) {
    return null;
  }
  return resolvePackageEntrySource(params);
}

function resolvePackageRuntimeEntrySource(params: {
  packageDir: string;
  packageRootRealPath?: string;
  entryPath: string;
  runtimeEntryPath?: string;
  runtimeEntryLabel?: string;
  origin: PluginOrigin;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string | null {
  const safeEntry = resolveSafePackageEntry({
    packageDir: params.packageDir,
    ...(params.packageRootRealPath !== undefined
      ? { packageRootRealPath: params.packageRootRealPath }
      : {}),
    entryPath: params.entryPath,
    sourceLabel: params.sourceLabel,
    diagnostics: params.diagnostics,
    rejectHardlinks: params.rejectHardlinks,
  });
  if (!safeEntry) {
    return null;
  }

  if (params.runtimeEntryPath) {
    const runtimeSource = resolvePackageEntrySource({
      packageDir: params.packageDir,
      ...(params.packageRootRealPath !== undefined
        ? { packageRootRealPath: params.packageRootRealPath }
        : {}),
      entryPath: params.runtimeEntryPath,
      sourceLabel: params.sourceLabel,
      diagnostics: params.diagnostics,
      rejectHardlinks: params.rejectHardlinks,
    });
    if (runtimeSource) {
      return runtimeSource;
    }
    params.diagnostics.push({
      level: "error",
      message: `${params.runtimeEntryLabel ?? "runtime entry"} not found: ${params.runtimeEntryPath}`,
      source: params.sourceLabel,
    });
    return null;
  }

  if (shouldInferBuiltRuntimeEntry(params.origin)) {
    for (const candidate of listBuiltRuntimeEntryCandidates(safeEntry.relativePath)) {
      const runtimeSource = resolveExistingPackageEntrySource({
        packageDir: params.packageDir,
        ...(params.packageRootRealPath !== undefined
          ? { packageRootRealPath: params.packageRootRealPath }
          : {}),
        entryPath: candidate,
        sourceLabel: params.sourceLabel,
        diagnostics: params.diagnostics,
        rejectHardlinks: params.rejectHardlinks,
      });
      if (runtimeSource) {
        return runtimeSource;
      }
    }
  }

  if (safeEntry.existingSource) {
    return safeEntry.existingSource;
  }

  return resolvePackageEntrySource({
    packageDir: params.packageDir,
    ...(params.packageRootRealPath !== undefined
      ? { packageRootRealPath: params.packageRootRealPath }
      : {}),
    entryPath: params.entryPath,
    sourceLabel: params.sourceLabel,
    diagnostics: params.diagnostics,
    rejectHardlinks: params.rejectHardlinks,
  });
}

export function resolvePackageSetupSource(params: {
  packageDir: string;
  packageRootRealPath?: string;
  manifest: PackageManifest | null;
  origin: PluginOrigin;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string | null {
  const packageManifest = getPackageManifestMetadata(params.manifest ?? undefined);
  const setupEntryPath = normalizeOptionalString(packageManifest?.setupEntry);
  if (!setupEntryPath) {
    return null;
  }
  return resolvePackageRuntimeEntrySource({
    packageDir: params.packageDir,
    ...(params.packageRootRealPath !== undefined
      ? { packageRootRealPath: params.packageRootRealPath }
      : {}),
    entryPath: setupEntryPath,
    runtimeEntryPath: normalizeOptionalString(packageManifest?.runtimeSetupEntry),
    runtimeEntryLabel: "runtime setup entry",
    origin: params.origin,
    sourceLabel: params.sourceLabel,
    diagnostics: params.diagnostics,
    rejectHardlinks: params.rejectHardlinks,
  });
}

export function resolvePackageRuntimeExtensionSources(params: {
  packageDir: string;
  packageRootRealPath?: string;
  manifest: PackageManifest | null;
  extensions: readonly string[];
  origin: PluginOrigin;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string[] {
  const runtimeResolution = resolvePackageRuntimeExtensionEntries({
    manifest: params.manifest,
    extensions: params.extensions,
  });
  if (!runtimeResolution.ok) {
    params.diagnostics.push({
      level: "error",
      message: runtimeResolution.error,
      source: params.sourceLabel,
    });
    return [];
  }

  return params.extensions.flatMap((entryPath, index) => {
    const source = resolvePackageRuntimeEntrySource({
      packageDir: params.packageDir,
      ...(params.packageRootRealPath !== undefined
        ? { packageRootRealPath: params.packageRootRealPath }
        : {}),
      entryPath,
      runtimeEntryPath: runtimeResolution.runtimeExtensions[index],
      runtimeEntryLabel: "runtime extension entry",
      origin: params.origin,
      sourceLabel: params.sourceLabel,
      diagnostics: params.diagnostics,
      rejectHardlinks: params.rejectHardlinks,
    });
    return source ? [source] : [];
  });
}
