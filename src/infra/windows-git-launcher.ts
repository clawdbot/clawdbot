import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasErrnoCode } from "./errors.js";
import { resolveRequiredOsHomeDir } from "./home-dir.js";
import { resolveNodeRuntimeInfo } from "./node-runtime-info.js";
import { replaceFileAtomic } from "./replace-file.js";
import { resolveStableNodePath } from "./stable-node-path.js";
import {
  decodeWindowsLauncherScript,
  encodeWindowsLauncherScript,
} from "./windows-launcher-encoding.js";

const WINDOWS_GIT_LAUNCHER_MARKER = "rem OpenClaw Git launcher";

type WindowsGitLauncherReconcileResult =
  | { status: "skipped"; reason: "not-windows" | "missing" | "foreign" }
  | { status: "needs-reinstall"; launcherPath: string }
  | { status: "needs-repair"; launcherPath: string }
  | { status: "unchanged"; launcherPath: string }
  | { status: "created" | "updated"; launcherPath: string };

function escapeCmdLiteral(value: string): string {
  if (value.includes("\u0000") || /[\r\n"]/u.test(value)) {
    throw new Error("Windows Git launcher paths cannot contain NUL, quotes, CR, or LF");
  }
  // Quoted batch arguments preserve carets, and delayed expansion is disabled
  // below so bangs stay literal. Percents still double to prevent expansion.
  return value.replaceAll("%", "%%");
}

/** Renders the persistent Windows Git launcher shared by install and update repair. */
function renderWindowsGitLauncher(params: { nodePath: string; entryPath: string }): string {
  const nodePath = escapeCmdLiteral(params.nodePath);
  const entryPath = escapeCmdLiteral(params.entryPath);
  return [
    "@echo off",
    WINDOWS_GIT_LAUNCHER_MARKER,
    "setlocal DisableDelayedExpansion",
    `if exist "${nodePath}" goto openclaw_runtime_ready`,
    "echo [!] OpenClaw's validated Node.js runtime is missing. 1>&2",
    "echo [i] Re-run the OpenClaw installer to repair this Git installation. 1>&2",
    "exit /b 1",
    ":openclaw_runtime_ready",
    `"${nodePath}" "${entryPath}" %*`,
    "",
  ].join("\r\n");
}

function normalizeWindowsPath(value: string): string {
  return path.win32.normalize(value).toLowerCase();
}

function isManagedLauncherForEntry(content: string, entryPath: string): boolean {
  const normalizedEntryPath = normalizeWindowsPath(entryPath);
  const legacyMatch = /^@echo off\r?\nnode "([^"\r\n]+)" %\*(?:\r?\n)?$/u.exec(content);
  if (legacyMatch?.[1] && normalizeWindowsPath(legacyMatch[1]) === normalizedEntryPath) {
    return true;
  }
  const managedMatch =
    /^@echo off\r?\nrem OpenClaw Git launcher\r?\nsetlocal DisableDelayedExpansion\r?\nif exist "([^"\r\n]+)" goto openclaw_runtime_ready\r?\necho \[!\] OpenClaw's validated Node\.js runtime is missing\. 1>&2\r?\necho \[i\] Re-run the OpenClaw installer to repair this Git installation\. 1>&2\r?\nexit \/b 1\r?\n:openclaw_runtime_ready\r?\n"\1" "([^"\r\n]+)" %\*\r?\n$/u.exec(
      content,
    );
  const encodedEntryPath = managedMatch?.[2];
  if (!encodedEntryPath) {
    return false;
  }
  const decodedEntryPath = encodedEntryPath.replaceAll("%%", "%");
  return (
    escapeCmdLiteral(decodedEntryPath) === encodedEntryPath &&
    normalizeWindowsPath(decodedEntryPath) === normalizedEntryPath
  );
}

async function assertFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

/** Creates a Git launcher or migrates an existing installer-owned launcher. */
export async function reconcileWindowsGitLauncher(params: {
  root: string;
  repair: boolean;
  create?: boolean;
  nodePath?: string;
  entryPath?: string;
  launcherPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): Promise<WindowsGitLauncherReconcileResult> {
  if ((params.platform ?? process.platform) !== "win32") {
    return { status: "skipped", reason: "not-windows" };
  }
  const env = params.env ?? process.env;
  const nodePath = await resolveStableNodePath(params.nodePath ?? process.execPath);
  const entryPath = params.entryPath ?? path.join(params.root, "dist", "entry.js");
  const userProfile = normalizeOptionalString(env.USERPROFILE);
  const launcherPath =
    params.launcherPath ??
    path.join(
      userProfile
        ? path.resolve(userProfile)
        : resolveRequiredOsHomeDir(env, params.homedir ?? os.homedir),
      ".local",
      "bin",
      "openclaw.cmd",
    );
  const desired = renderWindowsGitLauncher({ nodePath, entryPath });
  const current = await fs
    .readFile(launcherPath)
    .then((buffer) => decodeWindowsLauncherScript({ buffer }))
    .catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    });

  if (current === null) {
    if (!params.create) {
      return { status: "skipped", reason: "missing" };
    }
  } else if (current === desired) {
    return { status: "unchanged", launcherPath };
  } else if (!isManagedLauncherForEntry(current, entryPath)) {
    return { status: "skipped", reason: "foreign" };
  }

  // A legacy PATH launcher can start Doctor through an arbitrary shadow Node.
  // Never turn that process into durable launcher authority without reproving it.
  const runtime = await resolveNodeRuntimeInfo(nodePath);
  if (!runtime.supported) {
    return { status: "needs-reinstall", launcherPath };
  }
  if (current !== null && !params.repair) {
    return { status: "needs-repair", launcherPath };
  }

  await Promise.all([
    assertFile(nodePath, "Validated Node.js runtime"),
    assertFile(entryPath, "OpenClaw build entrypoint"),
  ]);
  await replaceFileAtomic({
    filePath: launcherPath,
    content: encodeWindowsLauncherScript({ format: "cmd", content: desired }),
    mode: 0o700,
    dirMode: 0o700,
    copyFallbackOnPermissionError: true,
    syncTempFile: true,
    syncParentDir: true,
    tempPrefix: "openclaw.cmd",
  });
  return { status: current === null ? "created" : "updated", launcherPath };
}
