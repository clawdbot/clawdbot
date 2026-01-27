import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LEGACY_MANIFEST_KEY } from "../compat/legacy-names.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import {
  extractArchive,
  fileExists,
  readJsonFile,
  resolveArchiveKind,
  resolvePackedRootDir,
} from "../infra/archive.js";
import { parseFrontmatter } from "./frontmatter.js";

export type HookInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type HookPackageManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  moltbot?: { hooks?: string[] };
  [LEGACY_MANIFEST_KEY]?: { hooks?: string[] };
};

export type InstallHooksResult =
  | {
      ok: true;
      hookPackId: string;
      hooks: string[];
      targetDir: string;
      version?: string;
    }
  | { ok: false; error: string };

const defaultLogger: HookInstallLogger = {};

function unscopedPackageName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return trimmed.includes("/") ? (trimmed.split("/").pop() ?? trimmed) : trimmed;
}

function safeDirName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  return trimmed.replaceAll("/", "__");
}

export function resolveHookInstallDir(hookId: string, hooksDir?: string): string {
  const hooksBase = hooksDir ? resolveUserPath(hooksDir) : path.join(CONFIG_DIR, "hooks");
  return path.join(hooksBase, safeDirName(hookId));
}

async function ensureMoltbotHooks(manifest: HookPackageManifest) {
  const hooks = manifest.moltbot?.hooks ?? manifest[LEGACY_MANIFEST_KEY]?.hooks;
  if (!Array.isArray(hooks)) {
    throw new Error("package.json missing moltbot.hooks");
  }
  const list = hooks.map((e) => (typeof e === "string" ? e.trim() : "")).filter(Boolean);
  if (list.length === 0) {
    throw new Error("package.json moltbot.hooks is empty");
  }
  return list;
}

async function resolveHookNameFromDir(hookDir: string): Promise<string> {
  const hookMdPath = path.join(hookDir, "HOOK.md");
  if (!(await fileExists(hookMdPath))) {
    throw new Error(`HOOK.md missing in ${hookDir}`);
  }
  const raw = await fs.readFile(hookMdPath, "utf-8");
  const frontmatter = parseFrontmatter(raw);
  return frontmatter.name || path.basename(hookDir);
}

async function validateHookDir(hookDir: string): Promise<void> {
  const hookMdPath = path.join(hookDir, "HOOK.md");
  if (!(await fileExists(hookMdPath))) {
    throw new Error(`HOOK.md missing in ${hookDir}`);
  }

  const handlerCandidates = ["handler.ts", "handler.js", "index.ts", "index.js"];
  const hasHandler = await Promise.all(
    handlerCandidates.map(async (candidate) => fileExists(path.join(hookDir, candidate))),
  ).then((results) => results.some(Boolean));

  if (!hasHandler) {
    throw new Error(`handler.ts/handler.js/index.ts/index.js missing in ${hookDir}`);
  }
}

async function installHookPackageFromDir(params: {
  packageDir: string;
  hooksDir?: string;
  timeoutMs?: number;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
}): Promise<InstallHooksResult> {
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const mode = params.mode ?? "install";
  const dryRun = params.dryRun ?? false;

  const manifestPath = path.join(params.packageDir, "package.json");
  if (!(await fileExists(manifestPath))) {
    return { ok: false, error: "package.json missing" };
  }

  let manifest: HookPackageManifest;
  try {
    manifest = await readJsonFile<HookPackageManifest>(manifestPath);
  } catch (err) {
    return { ok: false, error: `invalid package.json: ${String(err)}` };
  }

  let hookEntries: string[];
  try {
    hookEntries = await ensureMoltbotHooks(manifest);
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const pkgName = typeof manifest.name === "string" ? manifest.name : "";
  const hookPackId = pkgName ? unscopedPackageName(pkgName) : path.basename(params.packageDir);
  if (params.expectedHookPackId && params.expectedHookPackId !== hookPackId) {
    return {
      ok: false,
      error: `hook pack id mismatch: expected ${params.expectedHookPackId}, got ${hookPackId}`,
    };
  }

  const hooksDir = params.hooksDir
    ? resolveUserPath(params.hooksDir)
    : path.join(CONFIG_DIR, "hooks");
  await fs.mkdir(hooksDir, { recursive: true });

  const targetDir = resolveHookInstallDir(hookPackId, hooksDir);
  if (mode === "install" && (await fileExists(targetDir))) {
    return { ok: false, error: `hook pack already exists: ${targetDir} (delete it first)` };
  }

  const resolvedHooks = [] as string[];
  for (const entry of hookEntries) {
    const hookDir = path.resolve(params.packageDir, entry);
    await validateHookDir(hookDir);
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

  logger.info?.(`Installing to ${targetDir}…`);
  let backupDir: string | null = null;
  if (mode === "update" && (await fileExists(targetDir))) {
    backupDir = `${targetDir}.backup-${Date.now()}`;
    await fs.rename(targetDir, backupDir);
  }

  try {
    await fs.cp(params.packageDir, targetDir, { recursive: true });
  } catch (err) {
    if (backupDir) {
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rename(backupDir, targetDir).catch(() => undefined);
    }
    return { ok: false, error: `failed to copy hook pack: ${String(err)}` };
  }

  const deps = manifest.dependencies ?? {};
  const hasDeps = Object.keys(deps).length > 0;
  if (hasDeps) {
    logger.info?.("Installing hook pack dependencies…");
    const npmRes = await runCommandWithTimeout(["npm", "install", "--omit=dev", "--silent"], {
      timeoutMs: Math.max(timeoutMs, 300_000),
      cwd: targetDir,
    });
    if (npmRes.code !== 0) {
      if (backupDir) {
        await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
        await fs.rename(backupDir, targetDir).catch(() => undefined);
      }
      return {
        ok: false,
        error: `npm install failed: ${npmRes.stderr.trim() || npmRes.stdout.trim()}`,
      };
    }
  }

  if (backupDir) {
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
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
  const logger = params.logger ?? defaultLogger;
  const mode = params.mode ?? "install";
  const dryRun = params.dryRun ?? false;

  await validateHookDir(params.hookDir);
  const hookName = await resolveHookNameFromDir(params.hookDir);

  if (params.expectedHookPackId && params.expectedHookPackId !== hookName) {
    return {
      ok: false,
      error: `hook id mismatch: expected ${params.expectedHookPackId}, got ${hookName}`,
    };
  }

  const hooksDir = params.hooksDir
    ? resolveUserPath(params.hooksDir)
    : path.join(CONFIG_DIR, "hooks");
  await fs.mkdir(hooksDir, { recursive: true });

  const targetDir = resolveHookInstallDir(hookName, hooksDir);
  if (mode === "install" && (await fileExists(targetDir))) {
    return { ok: false, error: `hook already exists: ${targetDir} (delete it first)` };
  }

  if (dryRun) {
    return { ok: true, hookPackId: hookName, hooks: [hookName], targetDir };
  }

  logger.info?.(`Installing to ${targetDir}…`);
  let backupDir: string | null = null;
  if (mode === "update" && (await fileExists(targetDir))) {
    backupDir = `${targetDir}.backup-${Date.now()}`;
    await fs.rename(targetDir, backupDir);
  }

  try {
    await fs.cp(params.hookDir, targetDir, { recursive: true });
  } catch (err) {
    if (backupDir) {
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rename(backupDir, targetDir).catch(() => undefined);
    }
    return { ok: false, error: `failed to copy hook: ${String(err)}` };
  }

  if (backupDir) {
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return { ok: true, hookPackId: hookName, hooks: [hookName], targetDir };
}

export async function installHooksFromArchive(params: {
  archivePath: string;
  hooksDir?: string;
  timeoutMs?: number;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
}): Promise<InstallHooksResult> {
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;

  const archivePath = resolveUserPath(params.archivePath);
  if (!(await fileExists(archivePath))) {
    return { ok: false, error: `archive not found: ${archivePath}` };
  }

  if (!resolveArchiveKind(archivePath)) {
    return { ok: false, error: `unsupported archive: ${archivePath}` };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hook-"));
  const extractDir = path.join(tmpDir, "extract");
  await fs.mkdir(extractDir, { recursive: true });

  logger.info?.(`Extracting ${archivePath}…`);
  try {
    await extractArchive({ archivePath, destDir: extractDir, timeoutMs, logger });
  } catch (err) {
    return { ok: false, error: `failed to extract archive: ${String(err)}` };
  }

  let rootDir = "";
  try {
    rootDir = await resolvePackedRootDir(extractDir);
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const manifestPath = path.join(rootDir, "package.json");
  if (await fileExists(manifestPath)) {
    return await installHookPackageFromDir({
      packageDir: rootDir,
      hooksDir: params.hooksDir,
      timeoutMs,
      logger,
      mode: params.mode,
      dryRun: params.dryRun,
      expectedHookPackId: params.expectedHookPackId,
    });
  }

  return await installHookFromDir({
    hookDir: rootDir,
    hooksDir: params.hooksDir,
    logger,
    mode: params.mode,
    dryRun: params.dryRun,
    expectedHookPackId: params.expectedHookPackId,
  });
}

export async function installHooksFromNpmSpec(params: {
  spec: string;
  hooksDir?: string;
  timeoutMs?: number;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
}): Promise<InstallHooksResult> {
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const mode = params.mode ?? "install";
  const dryRun = params.dryRun ?? false;
  const expectedHookPackId = params.expectedHookPackId;
  const spec = params.spec.trim();
  if (!spec) return { ok: false, error: "missing npm spec" };

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-hook-pack-"));
  logger.info?.(`Downloading ${spec}…`);
  const res = await runCommandWithTimeout(["npm", "pack", spec], {
    timeoutMs: Math.max(timeoutMs, 300_000),
    cwd: tmpDir,
    env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  });
  if (res.code !== 0) {
    return { ok: false, error: `npm pack failed: ${res.stderr.trim() || res.stdout.trim()}` };
  }

  const packed = (res.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!packed) {
    return { ok: false, error: "npm pack produced no archive" };
  }

  const archivePath = path.join(tmpDir, packed);
  return await installHooksFromArchive({
    archivePath,
    hooksDir: params.hooksDir,
    timeoutMs,
    logger,
    mode,
    dryRun,
    expectedHookPackId,
  });
}

export async function installHooksFromPath(params: {
  path: string;
  hooksDir?: string;
  timeoutMs?: number;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
}): Promise<InstallHooksResult> {
  const resolved = resolveUserPath(params.path);
  if (!(await fileExists(resolved))) {
    return { ok: false, error: `path not found: ${resolved}` };
  }

  const stat = await fs.stat(resolved);
  if (stat.isDirectory()) {
    const manifestPath = path.join(resolved, "package.json");
    if (await fileExists(manifestPath)) {
      return await installHookPackageFromDir({
        packageDir: resolved,
        hooksDir: params.hooksDir,
        timeoutMs: params.timeoutMs,
        logger: params.logger,
        mode: params.mode,
        dryRun: params.dryRun,
        expectedHookPackId: params.expectedHookPackId,
      });
    }

    return await installHookFromDir({
      hookDir: resolved,
      hooksDir: params.hooksDir,
      logger: params.logger,
      mode: params.mode,
      dryRun: params.dryRun,
      expectedHookPackId: params.expectedHookPackId,
    });
  }

  if (!resolveArchiveKind(resolved)) {
    return { ok: false, error: `unsupported hook file: ${resolved}` };
  }

  return await installHooksFromArchive({
    archivePath: resolved,
    hooksDir: params.hooksDir,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
    expectedHookPackId: params.expectedHookPackId,
  });
}
