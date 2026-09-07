// Resolves package entry files for plugin loading and public surfaces.
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { matchRootFileOpenFailure, openRootFile } from "../infra/boundary-file-read.js";
import { resolveRootPath } from "../infra/boundary-path.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { getPackageManifestMetadata, type PackageManifest } from "./manifest.js";
import {
  isTypeScriptPackageEntry,
  listBuiltRuntimeEntryCandidates,
} from "./package-entrypoints.js";
import { checkPluginCacheEntry, pluginCacheExistsSync } from "./plugin-cache-files.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

type ExtensionEntryValidation = { ok: true; exists: boolean } | { ok: false; error: string };

type RuntimeExtensionsResolution =
  | { ok: true; runtimeExtensions: string[] }
  | { ok: false; error: string };

type PackageManifestStringList = { ok: true; entries: string[] } | { ok: false; error: string };

function runtimeExtensionsLengthMismatchMessage(params: {
  runtimeExtensionsLength: number;
  extensionsLength: number;
}): string {
  return (
    `package.json openclaw.runtimeExtensions length (${params.runtimeExtensionsLength}) ` +
    `must match openclaw.extensions length (${params.extensionsLength})`
  );
}

function readPackageManifestStringList(params: {
  fieldName: string;
  value: unknown;
}): PackageManifestStringList {
  if (!Array.isArray(params.value)) {
    return { ok: true, entries: [] };
  }
  const entries: string[] = [];
  for (const [index, entry] of params.value.entries()) {
    const normalized = normalizeOptionalString(entry);
    if (!normalized) {
      return {
        ok: false,
        error: `package.json ${params.fieldName}[${index}] must be a non-empty string`,
      };
    }
    entries.push(normalized);
  }
  return { ok: true, entries };
}

function resolvePackageRuntimeExtensionEntries(params: {
  manifest: PackageManifest | null | undefined;
  extensions: readonly string[];
}): RuntimeExtensionsResolution {
  const packageManifest = getPackageManifestMetadata(params.manifest ?? undefined);
  const runtimeExtensionsResult = readPackageManifestStringList({
    fieldName: "openclaw.runtimeExtensions",
    value: packageManifest?.runtimeExtensions,
  });
  if (!runtimeExtensionsResult.ok) {
    return runtimeExtensionsResult;
  }
  const runtimeExtensions = runtimeExtensionsResult.entries;
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

function missingCompiledRuntimeEntryMessage(params: {
  label: string;
  entry: string;
  candidates: readonly string[];
}): string {
  return `${params.label} requires compiled runtime output for TypeScript entry ${params.entry}: expected ${params.candidates.join(", ")}. This is a plugin packaging issue, not a local config problem; update or reinstall the plugin after the publisher ships compiled JavaScript, or disable/uninstall the plugin until then. TypeScript source fallback is only supported for source checkouts and local development paths.`;
}

async function validatePackageExtensionEntry(params: {
  packageDir: string;
  entry: string;
  label: string;
  requireExisting: boolean;
}): Promise<ExtensionEntryValidation> {
  const absolutePath = path.resolve(params.packageDir, params.entry);
  try {
    const resolved = await resolveRootPath({
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

  const opened = await openRootFile({
    absolutePath,
    rootPath: params.packageDir,
    boundaryLabel: "plugin package directory",
  });
  if (!opened.ok) {
    return matchRootFileOpenFailure(opened, {
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

async function validatePackageEntryForInstall(params: {
  packageDir: string;
  entry: string;
  runtimeEntry?: string;
  entryKind: "extension" | "setup";
  allowSourceTypeScriptEntries?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const sourceEntry = await validatePackageExtensionEntry({
    packageDir: params.packageDir,
    entry: params.entry,
    label: `${params.entryKind} entry`,
    requireExisting: false,
  });
  if (!sourceEntry.ok) {
    return sourceEntry;
  }

  if (params.runtimeEntry) {
    const runtimeResult = await validatePackageExtensionEntry({
      packageDir: params.packageDir,
      entry: params.runtimeEntry,
      label: `runtime ${params.entryKind} entry`,
      requireExisting: true,
    });
    return runtimeResult.ok ? { ok: true } : runtimeResult;
  }

  const builtEntryCandidates = listBuiltRuntimeEntryCandidates(params.entry);
  for (const builtEntry of builtEntryCandidates) {
    const builtResult = await validatePackageExtensionEntry({
      packageDir: params.packageDir,
      entry: builtEntry,
      label: `inferred runtime ${params.entryKind} entry`,
      requireExisting: false,
    });
    if (!builtResult.ok) {
      return builtResult;
    }
    if (builtResult.exists) {
      return { ok: true };
    }
  }

  if (
    sourceEntry.exists &&
    (!isTypeScriptPackageEntry(params.entry) || params.allowSourceTypeScriptEntries)
  ) {
    return { ok: true };
  }
  if (builtEntryCandidates.length > 0) {
    return {
      ok: false,
      error: missingCompiledRuntimeEntryMessage({
        label: "package install",
        entry: params.entry,
        candidates: builtEntryCandidates,
      }),
    };
  }
  return { ok: false, error: `${params.entryKind} entry not found: ${params.entry}` };
}

/** Validates package extension/setup entries before installing a plugin package. */
export async function validatePackageExtensionEntriesForInstall(params: {
  packageDir: string;
  extensions: string[];
  manifest: PackageManifest;
  allowSourceTypeScriptEntries?: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const runtimeResolution = resolvePackageRuntimeExtensionEntries({
    manifest: params.manifest,
    extensions: params.extensions,
  });
  if (!runtimeResolution.ok) {
    return runtimeResolution;
  }

  for (const [index, entry] of params.extensions.entries()) {
    const result = await validatePackageEntryForInstall({
      packageDir: params.packageDir,
      entry,
      runtimeEntry: runtimeResolution.runtimeExtensions[index],
      entryKind: "extension",
      allowSourceTypeScriptEntries: params.allowSourceTypeScriptEntries,
    });
    if (!result.ok) {
      return result;
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
    return await validatePackageEntryForInstall({
      packageDir: params.packageDir,
      entry: setupEntry,
      runtimeEntry: runtimeSetupEntry,
      entryKind: "setup",
      allowSourceTypeScriptEntries: params.allowSourceTypeScriptEntries,
    });
  }

  return { ok: true };
}

function resolvePackageEntrySource(params: {
  packageDir: string;
  packageRootRealPath?: string;
  entryPath: string;
  pluginIdHint?: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): string | null {
  const source = path.resolve(params.packageDir, params.entryPath);
  const rejectHardlinks = params.rejectHardlinks ?? true;
  const candidates = [source];
  const openCandidate = (absolutePath: string): string | null => {
    const opened = checkPluginCacheEntry({
      rootDir: params.packageDir,
      relativePath: path.relative(params.packageDir, absolutePath),
      rootRealPath: params.packageRootRealPath,
      rejectHardlinks,
    });
    if (!opened.ok) {
      return matchRootFileOpenFailure(opened, {
        path: () => null,
        io: () => {
          params.diagnostics.push({
            level: "warn",
            ...(params.pluginIdHint ? { pluginId: params.pluginIdHint } : {}),
            message: `extension entry unreadable (I/O error): ${params.entryPath}`,
            source: params.sourceLabel,
          });
          return null;
        },
        fallback: () => {
          params.diagnostics.push({
            level: "error",
            ...(params.pluginIdHint ? { pluginId: params.pluginIdHint } : {}),
            message: `extension entry escapes package directory: ${params.entryPath}`,
            source: params.sourceLabel,
          });
          return null;
        },
      });
    }
    return opened.exists ? opened.path : null;
  };
  if (!rejectHardlinks) {
    const builtCandidate = source.replace(/\.[^.]+$/u, ".js");
    if (builtCandidate !== source) {
      candidates.push(builtCandidate);
    }
  }

  for (const candidate of candidates) {
    if (!pluginCacheExistsSync(candidate)) {
      continue;
    }
    return openCandidate(candidate);
  }

  return openCandidate(source);
}

function shouldInferBuiltRuntimeEntry(origin: PluginOrigin): boolean {
  return origin === "config" || origin === "global";
}

function shouldRequireBuiltRuntimeEntry(origin: PluginOrigin): boolean {
  return origin === "global";
}

function resolveSafePackageEntry(params: {
  packageDir: string;
  packageRootRealPath?: string;
  entryPath: string;
  pluginIdHint?: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): { relativePath: string; existingSource?: string } | null {
  const absolutePath = path.resolve(params.packageDir, params.entryPath);
  if (pluginCacheExistsSync(absolutePath)) {
    const existingSource = resolvePackageEntrySource({
      packageDir: params.packageDir,
      ...(params.packageRootRealPath !== undefined
        ? { packageRootRealPath: params.packageRootRealPath }
        : {}),
      entryPath: params.entryPath,
      pluginIdHint: params.pluginIdHint,
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

  const checked = checkPluginCacheEntry({
    rootDir: params.packageDir,
    relativePath: params.entryPath,
    rootRealPath: params.packageRootRealPath,
    rejectHardlinks: params.rejectHardlinks ?? true,
  });
  if (!checked.ok) {
    params.diagnostics.push({
      level: "error",
      ...(params.pluginIdHint ? { pluginId: params.pluginIdHint } : {}),
      message: `extension entry escapes package directory: ${params.entryPath}`,
      source: params.sourceLabel,
    });
    return null;
  }
  return { relativePath: path.relative(params.packageDir, absolutePath).replace(/\\/g, "/") };
}

function resolveOptionalExistingPackageEntrySource(params: {
  packageDir: string;
  packageRootRealPath?: string;
  entryPath: string;
  pluginIdHint?: string;
  sourceLabel: string;
  diagnostics: PluginDiagnostic[];
  rejectHardlinks?: boolean;
}): { status: "missing" } | { status: "invalid" } | { status: "resolved"; source: string } {
  const source = path.resolve(params.packageDir, params.entryPath);
  if (!pluginCacheExistsSync(source)) {
    return { status: "missing" };
  }
  const resolved = resolvePackageEntrySource(params);
  return resolved ? { status: "resolved", source: resolved } : { status: "invalid" };
}

function resolvePackageRuntimeEntrySource(params: {
  packageDir: string;
  packageRootRealPath?: string;
  entryPath: string;
  sourceEntryLabel?: string;
  runtimeEntryPath?: string;
  runtimeEntryLabel?: string;
  pluginIdHint?: string;
  origin: PluginOrigin;
  // undefined preserves the origin default; false explicitly allows source fallback.
  requireBuiltRuntimeEntry?: boolean;
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
    pluginIdHint: params.pluginIdHint,
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
      pluginIdHint: params.pluginIdHint,
      sourceLabel: params.sourceLabel,
      diagnostics: params.diagnostics,
      rejectHardlinks: params.rejectHardlinks,
    });
    if (runtimeSource) {
      return runtimeSource;
    }
    params.diagnostics.push({
      level: "error",
      ...(params.pluginIdHint ? { pluginId: params.pluginIdHint } : {}),
      message: `${params.runtimeEntryLabel ?? "runtime entry"} not found: ${params.runtimeEntryPath}`,
      source: params.sourceLabel,
    });
    return null;
  }

  if (shouldInferBuiltRuntimeEntry(params.origin)) {
    const builtEntryCandidates = listBuiltRuntimeEntryCandidates(safeEntry.relativePath);
    for (const candidate of builtEntryCandidates) {
      const runtimeSource = resolveOptionalExistingPackageEntrySource({
        packageDir: params.packageDir,
        ...(params.packageRootRealPath !== undefined
          ? { packageRootRealPath: params.packageRootRealPath }
          : {}),
        entryPath: candidate,
        pluginIdHint: params.pluginIdHint,
        sourceLabel: params.sourceLabel,
        diagnostics: params.diagnostics,
        rejectHardlinks: params.rejectHardlinks,
      });
      if (runtimeSource.status === "resolved") {
        return runtimeSource.source;
      }
      if (runtimeSource.status === "invalid") {
        return null;
      }
    }
    // Installed packages must ship compiled JS for TS entries; only trusted source paths fall back.
    if (
      (params.requireBuiltRuntimeEntry ?? shouldRequireBuiltRuntimeEntry(params.origin)) &&
      isTypeScriptPackageEntry(safeEntry.relativePath)
    ) {
      params.diagnostics.push({
        level: "warn",
        ...(params.pluginIdHint ? { pluginId: params.pluginIdHint } : {}),
        message: missingCompiledRuntimeEntryMessage({
          label: "installed plugin package",
          entry: safeEntry.relativePath,
          candidates: builtEntryCandidates,
        }),
        source: params.sourceLabel,
      });
      return null;
    }
  }

  if (safeEntry.existingSource) {
    return safeEntry.existingSource;
  }

  if (params.rejectHardlinks === false) {
    const trustedFallbackSource = resolvePackageEntrySource({
      packageDir: params.packageDir,
      ...(params.packageRootRealPath !== undefined
        ? { packageRootRealPath: params.packageRootRealPath }
        : {}),
      entryPath: params.entryPath,
      pluginIdHint: params.pluginIdHint,
      sourceLabel: params.sourceLabel,
      diagnostics: params.diagnostics,
      rejectHardlinks: params.rejectHardlinks,
    });
    if (trustedFallbackSource) {
      return trustedFallbackSource;
    }
  }

  params.diagnostics.push({
    level: "error",
    ...(params.pluginIdHint ? { pluginId: params.pluginIdHint } : {}),
    message: `${params.sourceEntryLabel ?? "extension entry"} not found: ${safeEntry.relativePath}`,
    source: params.sourceLabel,
  });
  return null;
}

/** Resolves the runtime setup source for a plugin package manifest. */
export function resolvePackageSetupSource(params: {
  packageDir: string;
  packageRootRealPath?: string;
  manifest: PackageManifest | null;
  pluginIdHint?: string;
  origin: PluginOrigin;
  requireBuiltRuntimeEntry?: boolean;
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
    sourceEntryLabel: "setup entry",
    runtimeEntryPath: normalizeOptionalString(packageManifest?.runtimeSetupEntry),
    runtimeEntryLabel: "runtime setup entry",
    pluginIdHint:
      params.pluginIdHint ??
      normalizeOptionalString(packageManifest?.plugin?.id) ??
      normalizeOptionalString(packageManifest?.channel?.id),
    origin: params.origin,
    ...(params.requireBuiltRuntimeEntry !== undefined
      ? { requireBuiltRuntimeEntry: params.requireBuiltRuntimeEntry }
      : {}),
    sourceLabel: params.sourceLabel,
    diagnostics: params.diagnostics,
    rejectHardlinks: params.rejectHardlinks,
  });
}

/** Resolves runtime extension sources for a plugin package manifest. */
export function resolvePackageRuntimeExtensionSources(params: {
  packageDir: string;
  packageRootRealPath?: string;
  manifest: PackageManifest | null;
  extensions: readonly string[];
  origin: PluginOrigin;
  pluginIdHint?: string;
  requireBuiltRuntimeEntry?: boolean;
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
      ...(params.pluginIdHint ? { pluginId: params.pluginIdHint } : {}),
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
      sourceEntryLabel: "extension entry",
      runtimeEntryPath: runtimeResolution.runtimeExtensions[index],
      runtimeEntryLabel: "runtime extension entry",
      pluginIdHint: params.pluginIdHint,
      origin: params.origin,
      ...(params.requireBuiltRuntimeEntry !== undefined
        ? { requireBuiltRuntimeEntry: params.requireBuiltRuntimeEntry }
        : {}),
      sourceLabel: params.sourceLabel,
      diagnostics: params.diagnostics,
      rejectHardlinks: params.rejectHardlinks,
    });
    return source ? [source] : [];
  });
}
