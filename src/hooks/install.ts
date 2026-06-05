// Hook install service installs hook packages from archives and local sources.
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { resolveSafeInstallDir, unscopedPackageName } from "../infra/install-safe-path.js";
import type { NpmIntegrityDrift, NpmSpecResolution } from "../infra/install-source-utils.js";
import type { InstallSafetyOverrides } from "../plugins/install-security-scan.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { parseFrontmatter } from "./frontmatter.js";

let hookInstallRuntimePromise: Promise<typeof import("./install.runtime.js")> | undefined;

async function loadHookInstallRuntime() {
  hookInstallRuntimePromise ??= import("./install.runtime.js");
  return hookInstallRuntimePromise;
}

/** Logger contract used by hook install and update operations. */
export type HookInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type HookPackageManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
} & Partial<Record<typeof MANIFEST_KEY, { hooks?: string[] }>>;

export type InstallHooksResult =
  | {
      ok: true;
      hookPackId: string;
      hooks: string[];
      targetDir: string;
      version?: string;
      npmResolution?: NpmSpecResolution;
      integrityDrift?: NpmIntegrityDrift;
    }
  | { ok: false; error: string };

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
};

type HookPackageInstallParams = { packageDir: string } & HookInstallForwardParams;
type HookArchiveInstallParams = { archivePath: string } & HookInstallForwardParams;
type HookPathInstallParams = { path: string } & HookInstallForwardParams;

function buildHookInstallForwardParams(params: HookInstallForwardParams): HookInstallForwardParams {
  return {
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    hooksDir: params.hooksDir,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
    expectedHookPackId: params.expectedHookPackId,
  };
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

async function ensureOpenClawHooks(manifest: HookPackageManifest) {
  const hooks = manifest[MANIFEST_KEY]?.hooks;
  if (!Array.isArray(hooks)) {
    throw new Error("package.json missing openclaw.hooks");
  }
  const list = normalizeTrimmedStringList(hooks);
  if (list.length === 0) {
    throw new Error("package.json openclaw.hooks is empty");
  }
  return list;
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

async function resolveAvailableHookInstallTarget(params: {
  id: string;
  hooksDir?: string;
  mode: "install" | "update";
  alreadyExistsError: (targetDir: string) => string;
}): Promise<{ ok: true; targetDir: string } | { ok: false; error: string }> {
  const runtime = await loadHookInstallRuntime();
  const targetDirResult = await resolveInstallTargetDir(params.id, params.hooksDir);
  if (!targetDirResult.ok) {
    return targetDirResult;
  }
  const targetDir = targetDirResult.targetDir;
  const availability = await runtime.ensureInstallTargetAvailable({
    mode: params.mode,
    targetDir,
    alreadyExistsError: params.alreadyExistsError(targetDir),
  });
  if (!availability.ok) {
    return availability;
  }
  return { ok: true, targetDir };
}

async function installFromResolvedHookDir(
  resolvedDir: string,
  params: HookInstallForwardParams,
): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const manifestPath = path.join(resolvedDir, "package.json");
  // A directory with package.json is a hook pack. A bare hook directory must
  // contain HOOK.md plus a handler file and installs as a single hook.
  if (await runtime.fileExists(manifestPath)) {
    return await installHookPackageFromDir({
      packageDir: resolvedDir,
      hooksDir: params.hooksDir,
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      mode: params.mode,
      dryRun: params.dryRun,
      expectedHookPackId: params.expectedHookPackId,
    });
  }
  return await installHookFromDir({
    hookDir: resolvedDir,
    hooksDir: params.hooksDir,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
    expectedHookPackId: params.expectedHookPackId,
  });
}

async function resolveHookNameFromDir(hookDir: string): Promise<string> {
  const runtime = await loadHookInstallRuntime();
  const hookMdPath = path.join(hookDir, "HOOK.md");
  if (!(await runtime.fileExists(hookMdPath))) {
    throw new Error(`HOOK.md missing in ${hookDir}`);
  }
  const raw = await fs.readFile(hookMdPath, "utf-8");
  const frontmatter = parseFrontmatter(raw);
  return frontmatter.name || path.basename(hookDir);
}

async function validateHookDir(hookDir: string): Promise<void> {
  const runtime = await loadHookInstallRuntime();
  const hookMdPath = path.join(hookDir, "HOOK.md");
  if (!(await runtime.fileExists(hookMdPath))) {
    throw new Error(`HOOK.md missing in ${hookDir}`);
  }

  const handlerCandidates = ["handler.ts", "handler.js", "index.ts", "index.js"];
  const hasHandler = await Promise.all(
    handlerCandidates.map(async (candidate) => runtime.fileExists(path.join(hookDir, candidate))),
  ).then((results) => results.some(Boolean));

  if (!hasHandler) {
    throw new Error(`handler.ts/handler.js/index.ts/index.js missing in ${hookDir}`);
  }
}

async function installHookPackageFromDir(
  params: HookPackageInstallParams,
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

  let hookEntries: string[];
  try {
    hookEntries = await ensureOpenClawHooks(manifest);
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const pkgName = typeof manifest.name === "string" ? manifest.name : "";
  const hookPackId = pkgName ? unscopedPackageName(pkgName) : path.basename(params.packageDir);
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

  const target = await resolveAvailableHookInstallTarget({
    id: hookPackId,
    hooksDir: params.hooksDir,
    mode,
    alreadyExistsError: (targetDir) => `hook pack already exists: ${targetDir} (delete it first)`,
  });
  if (!target.ok) {
    return target;
  }
  const targetDir = target.targetDir;

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

  if (dryRun) {
    return {
      ok: true,
      hookPackId,
      hooks: resolvedHooks,
      targetDir,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
    };
  }

  const installRes = await runtime.installPackageDirWithManifestDeps({
    sourceDir: params.packageDir,
    targetDir,
    mode,
    timeoutMs,
    logger,
    copyErrorPrefix: "failed to copy hook pack",
    depsLogMessage: "Installing hook pack dependencies…",
    manifestDependencies: manifest.dependencies,
  });
  if (!installRes.ok) {
    return installRes;
  }

  return {
    ok: true,
    hookPackId,
    hooks: resolvedHooks,
    targetDir,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
  };
}

async function installHookFromDir(params: {
  hookDir: string;
  hooksDir?: string;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
}): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const { logger, mode, dryRun } = runtime.resolveInstallModeOptions(params, defaultLogger);

  await validateHookDir(params.hookDir);
  const hookName = await resolveHookNameFromDir(params.hookDir);
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

  const target = await resolveAvailableHookInstallTarget({
    id: hookName,
    hooksDir: params.hooksDir,
    mode,
    alreadyExistsError: (targetDir) => `hook already exists: ${targetDir} (delete it first)`,
  });
  if (!target.ok) {
    return target;
  }
  const targetDir = target.targetDir;

  if (dryRun) {
    return { ok: true, hookPackId: hookName, hooks: [hookName], targetDir };
  }

  const installRes = await runtime.installPackageDir({
    sourceDir: params.hookDir,
    targetDir,
    mode,
    timeoutMs: 120_000,
    logger,
    copyErrorPrefix: "failed to copy hook",
    hasDeps: false,
    depsLogMessage: "Installing hook dependencies…",
  });
  if (!installRes.ok) {
    return installRes;
  }

  return { ok: true, hookPackId: hookName, hooks: [hookName], targetDir };
}

/** Install hooks from an archive after extracting and validating the archive root. */
export async function installHooksFromArchive(
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

  return await runtime.withExtractedArchiveRoot({
    archivePath,
    tempDirPrefix: "openclaw-hook-",
    timeoutMs,
    logger,
    onExtracted: async (rootDir) =>
      await installFromResolvedHookDir(
        rootDir,
        buildHookInstallForwardParams({
          hooksDir: params.hooksDir,
          timeoutMs,
          logger,
          mode: params.mode,
          dryRun: params.dryRun,
          expectedHookPackId: params.expectedHookPackId,
        }),
      ),
  });
}

/** Download, verify, and install an npm hook pack tarball. */
export async function installHooksFromNpmSpec(params: {
  spec: string;
  dangerouslyForceUnsafeInstall?: boolean;
  hooksDir?: string;
  timeoutMs?: number;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
  expectedIntegrity?: string;
  onIntegrityDrift?: (params: HookNpmIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<InstallHooksResult> {
  const runtime = await loadHookInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const expectedHookPackId = params.expectedHookPackId;
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
      hooksDir: params.hooksDir,
      timeoutMs,
      logger,
      mode,
      dryRun,
      expectedHookPackId,
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
  const forwardParams = buildHookInstallForwardParams({
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    hooksDir: params.hooksDir,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
    expectedHookPackId: params.expectedHookPackId,
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
