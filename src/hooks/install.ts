// Hook install service installs hook packages from archives and local sources.

import path from "node:path";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { resolveSafeInstallDir, unscopedPackageName } from "../infra/install-safe-path.js";
import type { NpmIntegrityDrift, NpmSpecResolution } from "../infra/install-source-utils.js";
import { readRegularFile } from "../infra/regular-file.js";
import { detectBundleManifestFormat } from "../plugins/bundle-manifest.js";
import {
  scanPackageInstallSource,
  scanInstalledPackageDependencyTree,
  type InstallSafetyOverrides,
} from "../plugins/install-security-scan.js";
import { PLUGIN_MANIFEST_FILENAME } from "../plugins/manifest.js";
import type { InstallPolicySource } from "../security/install-policy.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { parseFrontmatter } from "./frontmatter.js";

// HOOK.md is only parsed for frontmatter; a small cap prevents a malicious or
// malformed hook package from OOMing the install path.
const HOOK_MD_MAX_BYTES = 1024 * 1024;

const loadHookInstallRuntime = createLazyRuntimeModule(() => import("./install.runtime.js"));

/** Logger contract used by hook install and update operations. */
type HookInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type HookPackageManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
} & Partial<Record<typeof MANIFEST_KEY, { extensions?: string[]; hooks?: string[] }>>;

export type InstallHooksResult =
  | {
      ok: true;
      hookPackId: string;
      hooks: string[];
      packageKind?: "hook-only" | "plugin-capable";
      targetDir: string;
      version?: string;
      npmResolution?: NpmSpecResolution;
      integrityDrift?: NpmIntegrityDrift;
    }
  | {
      ok: false;
      error: string;
      code?: string;
    };

export const HOOK_INSTALL_ERROR_CODE = {
  MISSING_OPENCLAW_HOOKS: "missing_openclaw_hooks",
  EMPTY_OPENCLAW_HOOKS: "empty_openclaw_hooks",
} as const;

type HookInstallErrorCode = (typeof HOOK_INSTALL_ERROR_CODE)[keyof typeof HOOK_INSTALL_ERROR_CODE];

/** Integrity drift payload surfaced when npm metadata no longer matches an install record. */
export type HookNpmIntegrityDriftParams = {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: NpmSpecResolution;
};

const defaultLogger: HookInstallLogger = {};

type HookInstallForwardParams = InstallSafetyOverrides & {
  hooksDir?: string;
  timeoutMs?: number;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
  expectedPackageKind?: "hook-only";
  inspection?: "package-kind";
  installPolicyRequest?: {
    kind: "plugin-archive" | "plugin-dir" | "plugin-npm";
    requestedSpecifier: string;
    source: InstallPolicySource;
  };
};

type HookPackageInstallParams = { packageDir: string } & HookInstallForwardParams;
type HookArchiveInstallParams = { archivePath: string } & HookInstallForwardParams;
type HookPathInstallParams = { path: string } & HookInstallForwardParams;

function buildHookInstallForwardParams(params: HookInstallForwardParams): HookInstallForwardParams {
  return {
    config: params.config,
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    hooksDir: params.hooksDir,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
    expectedHookPackId: params.expectedHookPackId,
    expectedPackageKind: params.expectedPackageKind,
    inspection: params.inspection,
    installPolicyRequest: params.installPolicyRequest,
  };
}

function localHookInstallPolicySource(kind: "plugin-archive" | "plugin-dir"): InstallPolicySource {
  return kind === "plugin-archive"
    ? { kind: "archive", authority: "user", mutable: true, network: false }
    : { kind: "local-path", authority: "user", mutable: true, network: false };
}

async function runHookInstallScan(params: {
  hookPackId: string;
  scan: () => ReturnType<typeof scanPackageInstallSource>;
}): Promise<Extract<InstallHooksResult, { ok: false }> | null> {
  try {
    const result = await params.scan();
    if (!result?.blocked) {
      return null;
    }
    return {
      ok: false,
      error: result.blocked.reason,
      ...(result.blocked.code ? { code: result.blocked.code } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      error: `Hook pack "${params.hookPackId}" installation blocked: install policy failed (${String(error)})`,
      code: "security_scan_failed",
    };
  }
}

async function runHookInstallPolicy(params: {
  hookPackId: string;
  hookEntries: string[];
  packageName?: string;
  version?: string;
  packageDir: string;
  forward: HookInstallForwardParams;
  logger: HookInstallLogger;
  mode: "install" | "update";
}): Promise<Extract<InstallHooksResult, { ok: false }> | null> {
  const request = params.forward.installPolicyRequest;
  if (!request) {
    return null;
  }
  return await runHookInstallScan({
    hookPackId: params.hookPackId,
    scan: async () =>
      await scanPackageInstallSource({
        config: params.forward.config,
        dangerouslyForceUnsafeInstall: params.forward.dangerouslyForceUnsafeInstall,
        trustedSourceLinkedOfficialInstall: params.forward.trustedSourceLinkedOfficialInstall,
        packageDir: params.packageDir,
        pluginId: params.hookPackId,
        extensions: params.hookEntries,
        ...(params.packageName ? { packageName: params.packageName } : {}),
        ...(params.version ? { version: params.version } : {}),
        logger: params.logger,
        requestKind: request.kind,
        requestedSpecifier: request.requestedSpecifier,
        source: request.source,
        mode: params.mode,
      }),
  });
}

async function runHookInstalledDependencyPolicy(params: {
  hookPackId: string;
  installedDir: string;
  forward: HookInstallForwardParams;
  logger: HookInstallLogger;
  mode: "install" | "update";
}): Promise<Extract<InstallHooksResult, { ok: false }> | null> {
  const request = params.forward.installPolicyRequest;
  if (!request) {
    return null;
  }
  return await runHookInstallScan({
    hookPackId: params.hookPackId,
    scan: async () =>
      await scanInstalledPackageDependencyTree({
        config: params.forward.config,
        dangerouslyForceUnsafeInstall: params.forward.dangerouslyForceUnsafeInstall,
        trustedSourceLinkedOfficialInstall: params.forward.trustedSourceLinkedOfficialInstall,
        packageDir: params.installedDir,
        pluginId: params.hookPackId,
        logger: params.logger,
        requestKind: request.kind,
        requestedSpecifier: request.requestedSpecifier,
        source: request.source,
        mode: params.mode,
      }),
  });
}

function validateHookId(hookId: string): string | null {
  if (!hookId) {
    return "invalid hook name: missing";
  }
  if (hookId === "." || hookId === "..") {
    return "invalid hook name: reserved path segment";
  }
  if (hookId.includes("/") || hookId.includes("\\")) {
    return "invalid hook name: path separators not allowed";
  }
  return null;
}

/** Resolve the canonical local install directory for one hook pack id. */
export function resolveHookInstallDir(hookId: string, hooksDir?: string): string {
  const hooksBase = hooksDir ? resolveUserPath(hooksDir) : path.join(CONFIG_DIR, "hooks");
  const hookIdError = validateHookId(hookId);
  if (hookIdError) {
    throw new Error(hookIdError);
  }
  const targetDirResult = resolveSafeInstallDir({
    baseDir: hooksBase,
    id: hookId,
    invalidNameMessage: "invalid hook name: path traversal detected",
  });
  if (!targetDirResult.ok) {
    throw new Error(targetDirResult.error);
  }
  return targetDirResult.path;
}

function resolveOpenClawHooks(
  manifest: HookPackageManifest,
): { ok: true; entries: string[] } | { ok: false; error: string; code: HookInstallErrorCode } {
  const hooks = manifest[MANIFEST_KEY]?.hooks;
  if (!Array.isArray(hooks)) {
    return {
      ok: false,
      error: "package.json missing openclaw.hooks",
      code: HOOK_INSTALL_ERROR_CODE.MISSING_OPENCLAW_HOOKS,
    };
  }
  const list = normalizeTrimmedStringList(hooks);
  if (list.length === 0) {
    return {
      ok: false,
      error: "package.json openclaw.hooks is empty",
      code: HOOK_INSTALL_ERROR_CODE.EMPTY_OPENCLAW_HOOKS,
    };
  }
  return { ok: true, entries: list };
}

function resolveHookPackageKind(
  manifest: HookPackageManifest,
  packageKind: "plugin-capable" | undefined,
): "hook-only" | "plugin-capable" {
  if (packageKind) {
    return packageKind;
  }
  const extensions = manifest[MANIFEST_KEY]?.extensions;
  if (extensions === undefined) {
    return "hook-only";
  }
  return Array.isArray(extensions) && normalizeTrimmedStringList(extensions).length === 0
    ? "hook-only"
    : "plugin-capable";
}

function resolveHookInstallTargetPath(
  id: string,
  hooksDir?: string,
): { ok: true; targetDir: string } | { ok: false; error: string } {
  const baseHooksDir = hooksDir ? resolveUserPath(hooksDir) : path.join(CONFIG_DIR, "hooks");
  const result = resolveSafeInstallDir({
    baseDir: baseHooksDir,
    id,
    invalidNameMessage: "invalid hook name: path traversal detected",
  });
  return result.ok ? { ok: true, targetDir: result.path } : result;
}

async function resolveInstallTargetDir(
  id: string,
  hooksDir?: string,
): Promise<{ ok: true; targetDir: string } | { ok: false; error: string }> {
  const runtime = await loadHookInstallRuntime();
  const baseHooksDir = hooksDir ? resolveUserPath(hooksDir) : path.join(CONFIG_DIR, "hooks");
  return await runtime.resolveCanonicalInstallTarget({
    baseDir: baseHooksDir,
    id,
    invalidNameMessage: "invalid hook name: path traversal detected",
    boundaryLabel: "hooks directory",
  });
}

type PreparedHookInstallTarget = {
  targetDir: string;
  effectiveMode: "install" | "update";
};

async function resolvePreparedHookInstallTarget(params: {
  id: string;
  hooksDir?: string;
  requestedMode: "install" | "update";
  alreadyExistsError: (targetDir: string) => string;
}): Promise<{ ok: true; target: PreparedHookInstallTarget } | { ok: false; error: string }> {
  const runtime = await loadHookInstallRuntime();
  const targetDirResult = await resolveInstallTargetDir(params.id, params.hooksDir);
  if (!targetDirResult.ok) {
    return targetDirResult;
  }
  const targetDir = targetDirResult.targetDir;
  const effectiveMode =
    params.requestedMode === "update" && (await runtime.fileExists(targetDir))
      ? "update"
      : "install";
  const availability = await runtime.ensureInstallTargetAvailable({
    mode: effectiveMode,
    targetDir,
    alreadyExistsError: params.alreadyExistsError(targetDir),
  });
  if (!availability.ok) {
    return availability;
  }
  return { ok: true, target: { targetDir, effectiveMode } };
}

async function installFromResolvedHookDir(
  resolvedDir: string,
  params: HookInstallForwardParams,
): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const manifestPath = path.join(resolvedDir, "package.json");
  const hasPluginManifest = await runtime.fileExists(
    path.join(resolvedDir, PLUGIN_MANIFEST_FILENAME),
  );
  const packageKind =
    hasPluginManifest || detectBundleManifestFormat(resolvedDir) !== null
      ? "plugin-capable"
      : undefined;
  // A directory with package.json is a hook pack. A bare hook directory must
  // contain HOOK.md plus a handler file and installs as a single hook.
  if (await runtime.fileExists(manifestPath)) {
    return await installHookPackageFromDir({
      packageDir: resolvedDir,
      ...(packageKind ? { packageKind } : {}),
      ...buildHookInstallForwardParams(params),
    });
  }
  return await installHookFromDir({
    hookDir: resolvedDir,
    ...(packageKind ? { packageKind } : {}),
    ...buildHookInstallForwardParams(params),
  });
}

async function resolveHookNameFromDir(hookDir: string): Promise<string> {
  const runtime = await loadHookInstallRuntime();
  const hookMdPath = path.join(hookDir, "HOOK.md");
  if (!(await runtime.fileExists(hookMdPath))) {
    throw new Error(`HOOK.md missing in ${hookDir}`);
  }
  const { buffer } = await readRegularFile({ filePath: hookMdPath, maxBytes: HOOK_MD_MAX_BYTES });
  const frontmatter = parseFrontmatter(buffer.toString("utf-8"));
  return frontmatter.name || path.basename(hookDir);
}

async function validateHookDir(hookDir: string): Promise<{ handlerEntry: string }> {
  const runtime = await loadHookInstallRuntime();
  const hookMdPath = path.join(hookDir, "HOOK.md");
  if (!(await runtime.fileExists(hookMdPath))) {
    throw new Error(`HOOK.md missing in ${hookDir}`);
  }

  const handlerCandidates = ["handler.ts", "handler.js", "index.ts", "index.js"];
  const handlerExists = await Promise.all(
    handlerCandidates.map(async (candidate) => runtime.fileExists(path.join(hookDir, candidate))),
  );
  const handlerEntry = handlerCandidates[handlerExists.findIndex(Boolean)];

  if (!handlerEntry) {
    throw new Error(`handler.ts/handler.js/index.ts/index.js missing in ${hookDir}`);
  }
  return { handlerEntry };
}

async function installHookPackageFromDir(
  params: HookPackageInstallParams & { packageKind?: "plugin-capable" },
): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );

  const manifestPath = path.join(params.packageDir, "package.json");
  if (!(await runtime.fileExists(manifestPath))) {
    return { ok: false, error: "package.json missing" };
  }

  let manifest: HookPackageManifest;
  try {
    manifest = await runtime.readJsonFile<HookPackageManifest>(manifestPath);
  } catch (err) {
    return { ok: false, error: `invalid package.json: ${String(err)}` };
  }

  const hookManifest = resolveOpenClawHooks(manifest);
  if (!hookManifest.ok) {
    return hookManifest;
  }
  const hookEntries = hookManifest.entries;

  const pkgName = typeof manifest.name === "string" ? manifest.name : "";
  const hookPackId = pkgName ? unscopedPackageName(pkgName) : path.basename(params.packageDir);
  const packageKind = resolveHookPackageKind(manifest, params.packageKind);
  if (params.expectedPackageKind && packageKind !== params.expectedPackageKind) {
    return {
      ok: false,
      error: `hook package kind mismatch: expected ${params.expectedPackageKind}, got ${packageKind}`,
    };
  }
  const hookIdError = validateHookId(hookPackId);
  if (hookIdError) {
    return { ok: false, error: hookIdError };
  }
  if (params.expectedHookPackId && params.expectedHookPackId !== hookPackId) {
    return {
      ok: false,
      error: `hook pack id mismatch: expected ${params.expectedHookPackId}, got ${hookPackId}`,
    };
  }

  const resolvedHooks = [] as string[];
  for (const entry of hookEntries) {
    const hookDir = path.resolve(params.packageDir, entry);
    // Validate both lexical containment and realpath containment so archive
    // symlinks cannot make package hook entries escape after extraction.
    if (!runtime.isPathInside(params.packageDir, hookDir)) {
      return {
        ok: false,
        error: `openclaw.hooks entry escapes package directory: ${entry}`,
      };
    }
    await validateHookDir(hookDir);
    if (
      !runtime.isPathInsideWithRealpath(params.packageDir, hookDir, {
        requireRealpath: true,
      })
    ) {
      return {
        ok: false,
        error: `openclaw.hooks entry resolves outside package directory: ${entry}`,
      };
    }
    const hookName = await resolveHookNameFromDir(hookDir);
    resolvedHooks.push(hookName);
  }

  if (params.inspection === "package-kind") {
    const targetDirResult = resolveHookInstallTargetPath(hookPackId, params.hooksDir);
    if (!targetDirResult.ok) {
      return targetDirResult;
    }
    return {
      ok: true,
      hookPackId,
      hooks: resolvedHooks,
      packageKind,
      targetDir: targetDirResult.targetDir,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
    };
  }

  const preparedTarget = await resolvePreparedHookInstallTarget({
    id: hookPackId,
    hooksDir: params.hooksDir,
    requestedMode: mode,
    alreadyExistsError: (targetDir) => `hook pack already exists: ${targetDir} (delete it first)`,
  });
  if (!preparedTarget.ok) {
    return preparedTarget;
  }
  const { targetDir, effectiveMode } = preparedTarget.target;

  const policyFailure = await runHookInstallPolicy({
    hookPackId,
    hookEntries,
    ...(pkgName ? { packageName: pkgName } : {}),
    ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
    packageDir: params.packageDir,
    forward: params,
    logger,
    mode: effectiveMode,
  });
  if (policyFailure) {
    return policyFailure;
  }

  if (dryRun) {
    return {
      ok: true,
      hookPackId,
      hooks: resolvedHooks,
      packageKind,
      targetDir,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
    };
  }

  const installRes = await runtime.installPackageDirWithManifestDeps({
    sourceDir: params.packageDir,
    targetDir,
    mode: effectiveMode,
    timeoutMs,
    logger,
    copyErrorPrefix: "failed to copy hook pack",
    depsLogMessage: "Installing hook pack dependencies…",
    manifestDependencies: manifest.dependencies,
    afterInstall: async (installedDir) => {
      const dependencyPolicyFailure = await runHookInstalledDependencyPolicy({
        hookPackId,
        installedDir,
        forward: params,
        logger,
        mode: effectiveMode,
      });
      return dependencyPolicyFailure ?? { ok: true };
    },
  });
  if (!installRes.ok) {
    return installRes;
  }

  return {
    ok: true,
    hookPackId,
    hooks: resolvedHooks,
    packageKind,
    targetDir,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
  };
}

async function installHookFromDir(
  params: {
    hookDir: string;
    packageKind?: "plugin-capable";
  } & HookInstallForwardParams,
): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const { logger, mode, dryRun } = runtime.resolveInstallModeOptions(params, defaultLogger);

  const { handlerEntry } = await validateHookDir(params.hookDir);
  const hookName = await resolveHookNameFromDir(params.hookDir);
  const packageKind = params.packageKind ?? "hook-only";
  if (params.expectedPackageKind && packageKind !== params.expectedPackageKind) {
    return {
      ok: false,
      error: `hook package kind mismatch: expected ${params.expectedPackageKind}, got ${packageKind}`,
    };
  }
  const hookIdError = validateHookId(hookName);
  if (hookIdError) {
    return { ok: false, error: hookIdError };
  }

  if (params.expectedHookPackId && params.expectedHookPackId !== hookName) {
    return {
      ok: false,
      error: `hook id mismatch: expected ${params.expectedHookPackId}, got ${hookName}`,
    };
  }

  if (params.inspection === "package-kind") {
    const targetDirResult = resolveHookInstallTargetPath(hookName, params.hooksDir);
    if (!targetDirResult.ok) {
      return targetDirResult;
    }
    return {
      ok: true,
      hookPackId: hookName,
      hooks: [hookName],
      packageKind,
      targetDir: targetDirResult.targetDir,
    };
  }

  const preparedTarget = await resolvePreparedHookInstallTarget({
    id: hookName,
    hooksDir: params.hooksDir,
    requestedMode: mode,
    alreadyExistsError: (targetDir) => `hook already exists: ${targetDir} (delete it first)`,
  });
  if (!preparedTarget.ok) {
    return preparedTarget;
  }
  const { targetDir, effectiveMode } = preparedTarget.target;

  const policyFailure = await runHookInstallPolicy({
    hookPackId: hookName,
    hookEntries: [handlerEntry],
    packageDir: params.hookDir,
    forward: params,
    logger,
    mode: effectiveMode,
  });
  if (policyFailure) {
    return policyFailure;
  }

  if (dryRun) {
    return {
      ok: true,
      hookPackId: hookName,
      hooks: [hookName],
      packageKind,
      targetDir,
    };
  }

  const installRes = await runtime.installPackageDir({
    sourceDir: params.hookDir,
    targetDir,
    mode: effectiveMode,
    timeoutMs: 120_000,
    logger,
    copyErrorPrefix: "failed to copy hook",
    hasDeps: false,
    depsLogMessage: "Installing hook dependencies…",
    afterInstall: async (installedDir) => {
      const stagedPolicyFailure = await runHookInstalledDependencyPolicy({
        hookPackId: hookName,
        installedDir,
        forward: params,
        logger,
        mode: effectiveMode,
      });
      return stagedPolicyFailure ?? { ok: true };
    },
  });
  if (!installRes.ok) {
    return installRes;
  }

  return {
    ok: true,
    hookPackId: hookName,
    hooks: [hookName],
    packageKind,
    targetDir,
  };
}

/** Install hooks from an archive after extracting and validating the archive root. */
async function installHooksFromArchive(
  params: HookArchiveInstallParams,
): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const archivePathResult = await runtime.resolveArchiveSourcePath(params.archivePath);
  if (!archivePathResult.ok) {
    return archivePathResult;
  }
  const archivePath = archivePathResult.path;
  const installPolicyRequest = params.installPolicyRequest ?? {
    kind: "plugin-archive",
    requestedSpecifier: params.archivePath,
    source: localHookInstallPolicySource("plugin-archive"),
  };

  return await runtime.withExtractedArchiveRoot({
    archivePath,
    tempDirPrefix: "openclaw-hook-",
    timeoutMs,
    logger,
    onExtracted: async (rootDir) =>
      await installFromResolvedHookDir(
        rootDir,
        buildHookInstallForwardParams({
          ...params,
          timeoutMs,
          logger,
          installPolicyRequest,
        }),
      ),
  });
}

/** Download, verify, and install an npm hook pack tarball. */
export async function installHooksFromNpmSpec(
  params: {
    spec: string;
    hooksDir?: string;
    timeoutMs?: number;
    logger?: HookInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedHookPackId?: string;
    expectedPackageKind?: "hook-only";
    inspection?: "package-kind";
    expectedIntegrity?: string;
    onIntegrityDrift?: (params: HookNpmIntegrityDriftParams) => boolean | Promise<boolean>;
  } & InstallSafetyOverrides,
): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const spec = params.spec;

  logger.info?.(`Downloading ${spec.trim()}…`);
  return await runtime.installFromValidatedNpmSpecArchive({
    tempDirPrefix: "openclaw-hook-pack-",
    spec,
    timeoutMs,
    expectedIntegrity: params.expectedIntegrity,
    onIntegrityDrift: params.onIntegrityDrift,
    warn: (message) => {
      logger.warn?.(message);
    },
    installFromArchive: installHooksFromArchive,
    archiveInstallParams: buildHookInstallForwardParams({
      ...params,
      timeoutMs,
      logger,
      mode,
      dryRun,
      installPolicyRequest: {
        kind: "plugin-npm",
        requestedSpecifier: spec,
        source: { kind: "npm", authority: "third-party", mutable: false, network: true },
      },
    }),
  });
}

/** Install a hook pack or single hook from a local directory/archive path. */
export async function installHooksFromPath(
  params: HookPathInstallParams,
): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const pathResult = await runtime.resolveExistingInstallPath(params.path);
  if (!pathResult.ok) {
    return pathResult;
  }
  const { resolvedPath: resolved, stat } = pathResult;
  const installPolicyKind = stat.isDirectory() ? "plugin-dir" : "plugin-archive";
  const forwardParams = buildHookInstallForwardParams({
    ...params,
    installPolicyRequest: {
      kind: installPolicyKind,
      requestedSpecifier: params.path,
      source: localHookInstallPolicySource(installPolicyKind),
    },
  });

  if (stat.isDirectory()) {
    return await installFromResolvedHookDir(resolved, forwardParams);
  }

  if (!runtime.resolveArchiveKind(resolved)) {
    return { ok: false, error: `unsupported hook file: ${resolved}` };
  }

  return await installHooksFromArchive({
    archivePath: resolved,
    ...forwardParams,
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
