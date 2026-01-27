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

type PluginInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type PackageManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  moltbot?: { extensions?: string[] };
  [LEGACY_MANIFEST_KEY]?: { extensions?: string[] };
};

export type InstallPluginResult =
  | {
      ok: true;
      pluginId: string;
      targetDir: string;
      manifestName?: string;
      version?: string;
      extensions: string[];
    }
  | { ok: false; error: string };

const defaultLogger: PluginInstallLogger = {};

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

function safeFileName(input: string): string {
  return safeDirName(input);
}

async function ensureMoltbotExtensions(manifest: PackageManifest) {
  const extensions = manifest.moltbot?.extensions ?? manifest[LEGACY_MANIFEST_KEY]?.extensions;
  if (!Array.isArray(extensions)) {
    throw new Error("package.json missing moltbot.extensions");
  }
  const list = extensions.map((e) => (typeof e === "string" ? e.trim() : "")).filter(Boolean);
  if (list.length === 0) {
    throw new Error("package.json moltbot.extensions is empty");
  }
  return list;
}

export function resolvePluginInstallDir(pluginId: string, extensionsDir?: string): string {
  const extensionsBase = extensionsDir
    ? resolveUserPath(extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  return path.join(extensionsBase, safeDirName(pluginId));
}

async function installPluginFromPackageDir(params: {
  packageDir: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
}): Promise<InstallPluginResult> {
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const mode = params.mode ?? "install";
  const dryRun = params.dryRun ?? false;

  const manifestPath = path.join(params.packageDir, "package.json");
  if (!(await fileExists(manifestPath))) {
    return { ok: false, error: "extracted package missing package.json" };
  }

  let manifest: PackageManifest;
  try {
    manifest = await readJsonFile<PackageManifest>(manifestPath);
  } catch (err) {
    return { ok: false, error: `invalid package.json: ${String(err)}` };
  }

  let extensions: string[];
  try {
    extensions = await ensureMoltbotExtensions(manifest);
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const pkgName = typeof manifest.name === "string" ? manifest.name : "";
  const pluginId = pkgName ? unscopedPackageName(pkgName) : "plugin";
  if (params.expectedPluginId && params.expectedPluginId !== pluginId) {
    return {
      ok: false,
      error: `plugin id mismatch: expected ${params.expectedPluginId}, got ${pluginId}`,
    };
  }

  const extensionsDir = params.extensionsDir
    ? resolveUserPath(params.extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  await fs.mkdir(extensionsDir, { recursive: true });

  const targetDir = path.join(extensionsDir, safeDirName(pluginId));

  if (mode === "install" && (await fileExists(targetDir))) {
    return {
      ok: false,
      error: `plugin already exists: ${targetDir} (delete it first)`,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      pluginId,
      targetDir,
      manifestName: pkgName || undefined,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
      extensions,
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
    return { ok: false, error: `failed to copy plugin: ${String(err)}` };
  }

  for (const entry of extensions) {
    const resolvedEntry = path.resolve(targetDir, entry);
    if (!(await fileExists(resolvedEntry))) {
      logger.warn?.(`extension entry not found: ${entry}`);
    }
  }

  const deps = manifest.dependencies ?? {};
  const hasDeps = Object.keys(deps).length > 0;
  if (hasDeps) {
    logger.info?.("Installing plugin dependencies…");
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
    pluginId,
    targetDir,
    manifestName: pkgName || undefined,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
    extensions,
  };
}

export async function installPluginFromArchive(params: {
  archivePath: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
}): Promise<InstallPluginResult> {
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const mode = params.mode ?? "install";

  const archivePath = resolveUserPath(params.archivePath);
  if (!(await fileExists(archivePath))) {
    return { ok: false, error: `archive not found: ${archivePath}` };
  }

  if (!resolveArchiveKind(archivePath)) {
    return { ok: false, error: `unsupported archive: ${archivePath}` };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-plugin-"));
  const extractDir = path.join(tmpDir, "extract");
  await fs.mkdir(extractDir, { recursive: true });

  logger.info?.(`Extracting ${archivePath}…`);
  try {
    await extractArchive({
      archivePath,
      destDir: extractDir,
      timeoutMs,
      logger,
    });
  } catch (err) {
    return { ok: false, error: `failed to extract archive: ${String(err)}` };
  }

  let packageDir = "";
  try {
    packageDir = await resolvePackedRootDir(extractDir);
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  return await installPluginFromPackageDir({
    packageDir,
    extensionsDir: params.extensionsDir,
    timeoutMs,
    logger,
    mode,
    dryRun: params.dryRun,
    expectedPluginId: params.expectedPluginId,
  });
}

export async function installPluginFromDir(params: {
  dirPath: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
}): Promise<InstallPluginResult> {
  const dirPath = resolveUserPath(params.dirPath);
  if (!(await fileExists(dirPath))) {
    return { ok: false, error: `directory not found: ${dirPath}` };
  }
  const stat = await fs.stat(dirPath);
  if (!stat.isDirectory()) {
    return { ok: false, error: `not a directory: ${dirPath}` };
  }

  return await installPluginFromPackageDir({
    packageDir: dirPath,
    extensionsDir: params.extensionsDir,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
    expectedPluginId: params.expectedPluginId,
  });
}

export async function installPluginFromFile(params: {
  filePath: string;
  extensionsDir?: string;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
}): Promise<InstallPluginResult> {
  const logger = params.logger ?? defaultLogger;
  const mode = params.mode ?? "install";
  const dryRun = params.dryRun ?? false;

  const filePath = resolveUserPath(params.filePath);
  if (!(await fileExists(filePath))) {
    return { ok: false, error: `file not found: ${filePath}` };
  }

  const extensionsDir = params.extensionsDir
    ? resolveUserPath(params.extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  await fs.mkdir(extensionsDir, { recursive: true });

  const base = path.basename(filePath, path.extname(filePath));
  const pluginId = base || "plugin";
  const targetFile = path.join(extensionsDir, `${safeFileName(pluginId)}${path.extname(filePath)}`);

  if (mode === "install" && (await fileExists(targetFile))) {
    return { ok: false, error: `plugin already exists: ${targetFile} (delete it first)` };
  }

  if (dryRun) {
    return {
      ok: true,
      pluginId,
      targetDir: targetFile,
      manifestName: undefined,
      version: undefined,
      extensions: [path.basename(targetFile)],
    };
  }

  logger.info?.(`Installing to ${targetFile}…`);
  await fs.copyFile(filePath, targetFile);

  return {
    ok: true,
    pluginId,
    targetDir: targetFile,
    manifestName: undefined,
    version: undefined,
    extensions: [path.basename(targetFile)],
  };
}

export async function installPluginFromNpmSpec(params: {
  spec: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
}): Promise<InstallPluginResult> {
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const mode = params.mode ?? "install";
  const dryRun = params.dryRun ?? false;
  const expectedPluginId = params.expectedPluginId;
  const spec = params.spec.trim();
  if (!spec) return { ok: false, error: "missing npm spec" };

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-npm-pack-"));
  logger.info?.(`Downloading ${spec}…`);
  const res = await runCommandWithTimeout(["npm", "pack", spec], {
    timeoutMs: Math.max(timeoutMs, 300_000),
    cwd: tmpDir,
    env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  });
  if (res.code !== 0) {
    return {
      ok: false,
      error: `npm pack failed: ${res.stderr.trim() || res.stdout.trim()}`,
    };
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
  return await installPluginFromArchive({
    archivePath,
    extensionsDir: params.extensionsDir,
    timeoutMs,
    logger,
    mode,
    dryRun,
    expectedPluginId,
  });
}

export async function installPluginFromPath(params: {
  path: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
}): Promise<InstallPluginResult> {
  const resolved = resolveUserPath(params.path);
  if (!(await fileExists(resolved))) {
    return { ok: false, error: `path not found: ${resolved}` };
  }

  const stat = await fs.stat(resolved);
  if (stat.isDirectory()) {
    return await installPluginFromDir({
      dirPath: resolved,
      extensionsDir: params.extensionsDir,
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      mode: params.mode,
      dryRun: params.dryRun,
      expectedPluginId: params.expectedPluginId,
    });
  }

  const archiveKind = resolveArchiveKind(resolved);
  if (archiveKind) {
    return await installPluginFromArchive({
      archivePath: resolved,
      extensionsDir: params.extensionsDir,
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      mode: params.mode,
      dryRun: params.dryRun,
      expectedPluginId: params.expectedPluginId,
    });
  }

  return await installPluginFromFile({
    filePath: resolved,
    extensionsDir: params.extensionsDir,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
  });
}
