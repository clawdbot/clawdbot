import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "../process/exec.js";
import { pathExists } from "./fs-safe.js";
import { assertCanonicalPathWithinBase } from "./install-safe-path.js";
import { tryReadJson, writeJson } from "./json-files.js";
import { movePathWithCopyFallback } from "./replace-file.js";
import { createSafeNpmInstallArgs, createSafeNpmInstallEnv } from "./safe-package-install.js";

const INSTALL_BASE_CHANGED_ERROR_MESSAGE = "install base directory changed during install";
const INSTALL_BASE_CHANGED_ABORT_WARNING =
  "Install base directory changed during install; aborting staged publish.";
const INSTALL_BASE_CHANGED_BACKUP_WARNING =
  "Install base directory changed before backup cleanup; leaving backup in place.";
const STAGED_NPM_PROJECT_CONFIG_NAME = ".npmrc";
const STAGED_NPM_PROJECT_CONFIG_PREFIX = ".openclaw-install-hidden-npmrc-";

type HiddenProjectConfigFile = {
  hiddenDir: string;
  originalPath: string;
  hiddenPath: string;
} | null;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function sanitizeManifestForNpmInstall(targetDir: string): Promise<void> {
  const manifestPath = path.join(targetDir, "package.json");
  const parsed = await tryReadJson<unknown>(manifestPath);
  if (!isObjectRecord(parsed)) {
    return;
  }
  const manifest = parsed;

  const devDependencies = manifest.devDependencies;
  if (!isObjectRecord(devDependencies)) {
    return;
  }

  const filteredEntries = Object.entries(devDependencies).filter(([, rawSpec]) => {
    const spec = typeof rawSpec === "string" ? rawSpec.trim() : "";
    return !spec.startsWith("workspace:");
  });
  if (filteredEntries.length === Object.keys(devDependencies).length) {
    return;
  }

  if (filteredEntries.length === 0) {
    delete manifest.devDependencies;
  } else {
    manifest.devDependencies = Object.fromEntries(filteredEntries);
  }
  await writeJson(manifestPath, manifest, { trailingNewline: true });
}

async function hideProjectNpmConfigForInstall(targetDir: string): Promise<HiddenProjectConfigFile> {
  const originalPath = path.join(targetDir, STAGED_NPM_PROJECT_CONFIG_NAME);
  let hiddenDir = "";
  try {
    hiddenDir = await fs.mkdtemp(path.join(targetDir, STAGED_NPM_PROJECT_CONFIG_PREFIX));
    const hiddenPath = path.join(hiddenDir, STAGED_NPM_PROJECT_CONFIG_NAME);
    await fs.rename(originalPath, hiddenPath);
    return { hiddenDir, originalPath, hiddenPath };
  } catch (error) {
    if (hiddenDir) {
      await fs.rm(hiddenDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function restoreProjectNpmConfigAfterInstall(
  hiddenConfig: HiddenProjectConfigFile,
): Promise<void> {
  if (!hiddenConfig) {
    return;
  }
  await fs.rename(hiddenConfig.hiddenPath, hiddenConfig.originalPath);
  await fs.rm(hiddenConfig.hiddenDir, { recursive: true, force: true });
}

async function assertInstallBoundaryPaths(params: {
  installBaseDir: string;
  candidatePaths: string[];
}): Promise<void> {
  for (const candidatePath of params.candidatePaths) {
    await assertCanonicalPathWithinBase({
      baseDir: params.installBaseDir,
      candidatePath,
      boundaryLabel: "install directory",
    });
  }
}

function isRelativePathInsideBase(relativePath: string): boolean {
  return (
    Boolean(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`)
  );
}

function isInstallBaseChangedError(error: unknown): boolean {
  return error instanceof Error && error.message === INSTALL_BASE_CHANGED_ERROR_MESSAGE;
}

async function assertInstallBaseStable(params: {
  installBaseDir: string;
  expectedRealPath: string;
}): Promise<void> {
  const baseStat = await fs.stat(params.installBaseDir);
  if (!baseStat.isDirectory()) {
    throw new Error(INSTALL_BASE_CHANGED_ERROR_MESSAGE);
  }
  const currentRealPath = await fs.realpath(params.installBaseDir);
  if (currentRealPath !== params.expectedRealPath) {
    throw new Error(INSTALL_BASE_CHANGED_ERROR_MESSAGE);
  }
}

async function cleanupInstallTempDir(dirPath: string | null): Promise<void> {
  if (!dirPath) {
    return;
  }
  await fs.rm(dirPath, { recursive: true, force: true }).catch(() => undefined);
}

async function resolveInstallPublishTarget(params: {
  installBaseDir: string;
  targetDir: string;
}): Promise<{ installBaseRealPath: string; canonicalTargetDir: string }> {
  const installBaseResolved = path.resolve(params.installBaseDir);
  const targetResolved = path.resolve(params.targetDir);
  const targetRelativePath = path.relative(installBaseResolved, targetResolved);
  if (!isRelativePathInsideBase(targetRelativePath)) {
    throw new Error("invalid install target path");
  }
  const installBaseRealPath = await fs.realpath(params.installBaseDir);
  return {
    installBaseRealPath,
    canonicalTargetDir: path.join(installBaseRealPath, targetRelativePath),
  };
}

export async function installPackageDir(params: {
  sourceDir: string;
  targetDir: string;
  mode: "install" | "update";
  timeoutMs: number;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  copyErrorPrefix: string;
  hasDeps: boolean;
  depsLogMessage: string;
  afterCopy?: (installedDir: string) => void | Promise<void>;
  afterInstall?: (
    installedDir: string,
  ) => Promise<{ ok: true } | { ok: false; error: string; code?: string }>;
}): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
  params.logger?.info?.(`Installing to ${params.targetDir}…`);
  const installBaseDir = path.dirname(params.targetDir);
  let initialInstallBaseRealPath: string;
  try {
    await fs.mkdir(installBaseDir, { recursive: true });
    initialInstallBaseRealPath = await fs.realpath(installBaseDir);
    await assertInstallBoundaryPaths({
      installBaseDir,
      candidatePaths: [params.targetDir],
    });
  } catch (err) {
    return { ok: false, error: `${params.copyErrorPrefix}: ${String(err)}` };
  }
  let installBaseRealPath: string;
  let canonicalTargetDir: string;
  try {
    ({ installBaseRealPath, canonicalTargetDir } = await resolveInstallPublishTarget({
      installBaseDir,
      targetDir: params.targetDir,
    }));
    if (installBaseRealPath !== initialInstallBaseRealPath) {
      throw new Error(INSTALL_BASE_CHANGED_ERROR_MESSAGE);
    }
  } catch (err) {
    if (isInstallBaseChangedError(err)) {
      params.logger?.warn?.(INSTALL_BASE_CHANGED_ABORT_WARNING);
    }
    return { ok: false, error: `${params.copyErrorPrefix}: ${String(err)}` };
  }

  let stageDir: string | null = null;
  let backupDir: string | null = null;
  const fail = async (error: string, cause?: unknown) => {
    const installBaseChanged = isInstallBaseChangedError(cause);
    if (installBaseChanged) {
      params.logger?.warn?.(INSTALL_BASE_CHANGED_ABORT_WARNING);
    } else {
      await restoreBackup();
      if (stageDir) {
        await cleanupInstallTempDir(stageDir);
        stageDir = null;
      }
    }
    return { ok: false as const, error };
  };
  const failWithCode = async (params: { error: string; code?: string }, cause?: unknown) => {
    const failed = await fail(params.error, cause);
    return params.code ? { ...failed, code: params.code } : failed;
  };
  const restoreBackup = async () => {
    if (!backupDir) {
      return;
    }
    await movePathWithCopyFallback({
      from: backupDir,
      sourceHardlinks: "reject",
      to: canonicalTargetDir,
    }).catch(() => undefined);
    backupDir = null;
  };

  try {
    await assertInstallBoundaryPaths({
      installBaseDir: installBaseRealPath,
      candidatePaths: [canonicalTargetDir],
    });
    stageDir = await fs.mkdtemp(path.join(installBaseRealPath, ".openclaw-install-stage-"));
    await fs.cp(params.sourceDir, stageDir, {
      recursive: true,
      // Keep relative symlinks relative to the staged copy. Node's default
      // rewrites them toward the source tree, which makes valid vendored
      // package links look like install-root escapes during post-copy scans.
      verbatimSymlinks: true,
    });
  } catch (err) {
    return await fail(`${params.copyErrorPrefix}: ${String(err)}`, err);
  }

  try {
    await params.afterCopy?.(stageDir);
  } catch (err) {
    return await fail(`post-copy validation failed: ${String(err)}`, err);
  }

  if (params.hasDeps) {
    try {
      await sanitizeManifestForNpmInstall(stageDir);
      const hiddenProjectNpmConfig = await hideProjectNpmConfigForInstall(stageDir);
      params.logger?.info?.(params.depsLogMessage);
      const npmRes = await (async () => {
        try {
          return await runCommandWithTimeout(
            // Plugins install into isolated directories, so omitting peer deps can strip
            // runtime requirements that npm would otherwise materialize for the package.
            // Verified on Blacksmith Ubuntu/Node 24/npm 11: `--silent` can make npm fail
            // with empty stdout/stderr for bad specs like `workspace:^`; `--loglevel=error`
            // stays quiet on success while preserving the actionable npm failure text.
            ["npm", ...createSafeNpmInstallArgs({ omitDev: true, loglevel: "error" })],
            {
              timeoutMs: Math.max(params.timeoutMs, 300_000),
              cwd: stageDir,
              env: createSafeNpmInstallEnv(process.env),
            },
          );
        } finally {
          await restoreProjectNpmConfigAfterInstall(hiddenProjectNpmConfig);
        }
      })();
      if (npmRes.code !== 0) {
        return await fail(`npm install failed: ${npmRes.stderr.trim() || npmRes.stdout.trim()}`);
      }
    } catch (error) {
      return await fail(`npm install failed: ${String(error)}`, error);
    }
  }

  if (params.afterInstall) {
    try {
      const postInstallResult = await params.afterInstall(stageDir);
      if (!postInstallResult.ok) {
        return await failWithCode(postInstallResult);
      }
    } catch (err) {
      return await fail(`post-install validation failed: ${String(err)}`, err);
    }
  }

  if (params.mode === "update" && (await pathExists(canonicalTargetDir))) {
    const backupRoot = path.join(installBaseRealPath, ".openclaw-install-backups");
    backupDir = path.join(backupRoot, `${path.basename(canonicalTargetDir)}-${Date.now()}`);
    try {
      await fs.mkdir(backupRoot, { recursive: true });
      await assertInstallBoundaryPaths({
        installBaseDir: installBaseRealPath,
        candidatePaths: [backupDir],
      });
      await assertInstallBaseStable({
        installBaseDir,
        expectedRealPath: installBaseRealPath,
      });
      await movePathWithCopyFallback({
        from: canonicalTargetDir,
        sourceHardlinks: "reject",
        to: backupDir,
      });
    } catch (err) {
      return await fail(`${params.copyErrorPrefix}: ${String(err)}`, err);
    }
  }

  try {
    await assertInstallBaseStable({
      installBaseDir,
      expectedRealPath: installBaseRealPath,
    });
    await movePathWithCopyFallback({
      from: stageDir,
      sourceHardlinks: "reject",
      to: canonicalTargetDir,
    });
    stageDir = null;
  } catch (err) {
    return await fail(`${params.copyErrorPrefix}: ${String(err)}`, err);
  }

  if (backupDir) {
    try {
      await assertInstallBaseStable({
        installBaseDir,
        expectedRealPath: installBaseRealPath,
      });
    } catch (err) {
      if (isInstallBaseChangedError(err)) {
        params.logger?.warn?.(INSTALL_BASE_CHANGED_BACKUP_WARNING);
      }
      backupDir = null;
    }
  }
  if (backupDir) {
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  }
  if (stageDir) {
    await cleanupInstallTempDir(stageDir);
  }

  return { ok: true };
}

export async function installPackageDirWithManifestDeps(params: {
  sourceDir: string;
  targetDir: string;
  mode: "install" | "update";
  timeoutMs: number;
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
  copyErrorPrefix: string;
  depsLogMessage: string;
  manifestDependencies?: Record<string, unknown>;
  afterCopy?: (installedDir: string) => void | Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return installPackageDir({
    ...params,
    hasDeps: Object.keys(params.manifestDependencies ?? {}).length > 0,
  });
}
