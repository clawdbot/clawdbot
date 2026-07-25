/** Native Computer Use service provisioning for isolated Codex homes. */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { resolveMacOSDesktopCodexComputerUseServiceAppCandidates } from "./desktop-app-paths.js";

const SERVICE_APP_NAME = "Codex Computer Use.app";
const CLIENT_RELATIVE_PATH = path.join(
  "Contents",
  "SharedSupport",
  "SkyComputerUseClient.app",
  "Contents",
  "MacOS",
  "SkyComputerUseClient",
);
const COPY_TIMEOUT_MS = 120_000;
const activeInstalls = new Map<string, Promise<CodexComputerUseServiceStatus>>();

type CodexComputerUseServiceStatus = {
  status: "installed" | "already_installed" | "source_missing" | "unsupported";
  changed: boolean;
  targetPath?: string;
  sourcePath?: string;
};

type CopyServiceApp = (sourcePath: string, targetPath: string) => Promise<void>;

/** Ensures the official native client exists beneath the CODEX_HOME used by its launcher. */
export async function ensureCodexComputerUseServiceApp(params: {
  codexHome: string;
  platform?: NodeJS.Platform;
  appServerCommand?: string;
  sourceAppCandidates?: readonly string[];
  copyServiceApp?: CopyServiceApp;
}): Promise<CodexComputerUseServiceStatus> {
  const platform = params.platform ?? process.platform;
  if (platform !== "darwin") {
    return { status: "unsupported", changed: false };
  }
  const targetPath = path.join(path.resolve(params.codexHome), "computer-use", SERVICE_APP_NAME);
  const active = activeInstalls.get(targetPath);
  if (active) {
    return await active;
  }
  const install = ensureCodexComputerUseServiceAppOnce({ ...params, targetPath, platform });
  activeInstalls.set(targetPath, install);
  try {
    return await install;
  } finally {
    if (activeInstalls.get(targetPath) === install) {
      activeInstalls.delete(targetPath);
    }
  }
}

async function ensureCodexComputerUseServiceAppOnce(params: {
  codexHome: string;
  targetPath: string;
  platform: NodeJS.Platform;
  appServerCommand?: string;
  sourceAppCandidates?: readonly string[];
  copyServiceApp?: CopyServiceApp;
}): Promise<CodexComputerUseServiceStatus> {
  if (await hasExecutableClient(params.targetPath)) {
    return { status: "already_installed", changed: false, targetPath: params.targetPath };
  }
  const candidates =
    params.sourceAppCandidates ??
    resolveMacOSDesktopCodexComputerUseServiceAppCandidates(
      params.platform,
      params.appServerCommand,
    );
  const sourcePath = await findUsableServiceApp(candidates);
  if (!sourcePath) {
    return { status: "source_missing", changed: false, targetPath: params.targetPath };
  }

  const targetParent = path.dirname(params.targetPath);
  await fs.mkdir(targetParent, { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(targetParent, ".service-app.staging-"));
  const stagedPath = path.join(stagingRoot, SERVICE_APP_NAME);
  const backupPath = path.join(targetParent, `.service-app.backup-${process.pid}-${Date.now()}`);
  let backupCreated = false;
  try {
    await (params.copyServiceApp ?? copyServiceAppWithDitto)(sourcePath, stagedPath);
    if (!(await hasExecutableClient(stagedPath))) {
      throw new Error(`Copied Computer Use service app is incomplete at ${stagedPath}.`);
    }
    if (await pathExists(params.targetPath)) {
      await fs.rename(params.targetPath, backupPath);
      backupCreated = true;
      if (await hasExecutableClient(backupPath)) {
        // A separate runtime can win after the initial target check. Restore
        // its complete signed app rather than replacing it from our staging copy.
        await fs.rename(backupPath, params.targetPath);
        backupCreated = false;
        return {
          status: "already_installed",
          changed: false,
          targetPath: params.targetPath,
          sourcePath,
        };
      }
    }
    try {
      await fs.rename(stagedPath, params.targetPath);
    } catch (error) {
      // Another runtime can finish the same isolated-home install first.
      // Preserve that complete winner instead of replacing a live signed app.
      if (!(await hasExecutableClient(params.targetPath))) {
        if (backupCreated) {
          await fs.rename(backupPath, params.targetPath);
          backupCreated = false;
        }
        throw error;
      }
      if (backupCreated) {
        await fs.rm(backupPath, { recursive: true, force: true });
        backupCreated = false;
      }
      return {
        status: "already_installed",
        changed: false,
        targetPath: params.targetPath,
        sourcePath,
      };
    }
    if (backupCreated) {
      await fs.rm(backupPath, { recursive: true, force: true });
      backupCreated = false;
    }
    return { status: "installed", changed: true, targetPath: params.targetPath, sourcePath };
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  return await fs.lstat(filePath).then(
    () => true,
    () => false,
  );
}

async function findUsableServiceApp(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await hasExecutableClient(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function hasExecutableClient(appPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(appPath, CLIENT_RELATIVE_PATH), fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function copyServiceAppWithDitto(sourcePath: string, targetPath: string): Promise<void> {
  await runExec("/usr/bin/ditto", ["--noqtn", sourcePath, targetPath], {
    logOutput: false,
    timeoutMs: COPY_TIMEOUT_MS,
  });
}
