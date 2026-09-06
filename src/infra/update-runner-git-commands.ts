import fs from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { hasErrnoCode } from "./errno.js";
import { resolvePnpmCandidateEnv } from "./update-package-manager.js";
import type { CommandRunner } from "./update-runner-types.js";

const BUILD_MAX_OLD_SPACE_MB = 8192;
const DEV_PREFLIGHT_LINT_ENV: NodeJS.ProcessEnv = {
  OPENCLAW_LOCAL_CHECK: "1",
  OPENCLAW_LOCAL_CHECK_MODE: "throttled",
};
const DEV_PREFLIGHT_LINT_OPT_IN_ENV = "OPENCLAW_UPDATE_PREFLIGHT_LINT";

export function shouldInstallWithoutScriptsOnWindows(manager: "pnpm" | "bun" | "npm"): boolean {
  return process.platform === "win32" && manager === "pnpm";
}

function resolveBuildNodeOptions(baseOptions: string | undefined): string {
  const current = baseOptions?.trim() ?? "";
  const desired = `--max-old-space-size=${BUILD_MAX_OLD_SPACE_MB}`;
  const existingMatch = /(?:^|\s)--max-old-space-size=(\d+)(?=\s|$)/.exec(current);
  if (!existingMatch) {
    return current ? `${current} ${desired}` : desired;
  }
  const existingValue = Number(existingMatch[1]);
  if (Number.isFinite(existingValue) && existingValue >= BUILD_MAX_OLD_SPACE_MB) {
    return current;
  }
  return current.replace(/(?:^|\s)--max-old-space-size=\d+(?=\s|$)/, ` ${desired}`).trim();
}

export function resolveBuildEnv(
  env: NodeJS.ProcessEnv = process.env,
  buildCacheRoot?: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    NODE_OPTIONS: resolveBuildNodeOptions(env.NODE_OPTIONS ?? process.env.NODE_OPTIONS),
    ...(buildCacheRoot ? { BUILD_ALL_CACHE_ROOT: buildCacheRoot } : {}),
  };
}

export function gitCleanCheckArgs(gitRoot: string): string[] {
  return ["git", "-C", gitRoot, "status", "--porcelain", "--", ":!dist/control-ui/"];
}

async function hasExplicitPnpmPreferOfflineConfig(params: {
  runCommand: CommandRunner;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  try {
    const result = await params.runCommand(["pnpm", "config", "get", "prefer-offline"], {
      cwd: params.cwd,
      timeoutMs: params.timeoutMs,
      env: params.env,
    });
    if (result.code !== 0) {
      return true;
    }
    // pnpm reports only explicitly configured typed values; these sentinels mean absent.
    const value = result.stdout.trim();
    return value !== "" && value !== "undefined" && value !== "null";
  } catch {
    // A failed provenance check must not override an operator's possible explicit policy.
    return true;
  }
}

export async function prepareCandidateCommandEnv(
  manager: "pnpm" | "bun" | "npm",
  env: NodeJS.ProcessEnv | undefined,
  cwd: string,
  runCommand: CommandRunner,
  timeoutMs: number,
): Promise<{ env: NodeJS.ProcessEnv | undefined; restoreWorkspace?: () => Promise<void> }> {
  if (manager !== "pnpm") {
    return { env };
  }
  const effectiveEnv = env ?? process.env;
  const hasExplicitPreferOffline =
    effectiveEnv.pnpm_config_prefer_offline !== undefined ||
    effectiveEnv.PNPM_CONFIG_PREFER_OFFLINE !== undefined;
  const hasConfigPreferOffline = hasExplicitPreferOffline
    ? false
    : await hasExplicitPnpmPreferOfflineConfig({ runCommand, cwd, timeoutMs, env: effectiveEnv });
  const candidateEnv: NodeJS.ProcessEnv = {
    ...resolvePnpmCandidateEnv(env, "node_modules/.pnpm"),
    PNPM_CONFIG_RESOLUTION_MODE: env?.PNPM_CONFIG_RESOLUTION_MODE ?? "highest",
    npm_config_resolution_mode: env?.npm_config_resolution_mode ?? "highest",
    pnpm_config_resolution_mode: env?.pnpm_config_resolution_mode ?? "highest",
  };
  if (!hasExplicitPreferOffline && !hasConfigPreferOffline) {
    candidateEnv.PNPM_CONFIG_PREFER_OFFLINE = "true";
    candidateEnv.pnpm_config_prefer_offline = "true";
  }
  const workspaceFile = path.join(cwd, "pnpm-workspace.yaml");
  const original = await fs.readFile(workspaceFile, "utf8").catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (original === undefined) {
    return { env: candidateEnv };
  }
  // pnpm 10 applies workspace settings after env, including in nested installs.
  // Only the disposable worktree gets this override; retain all operator settings.
  const workspace = parseDocument(original);
  workspace.set("virtualStoreDir", "node_modules/.pnpm");
  const isolated = workspace.toString();
  const backupDirectory = await fs.mkdtemp(path.join(path.dirname(cwd), "workspace-original-"));
  const backupFile = path.join(backupDirectory, "pnpm-workspace.yaml");
  // Move the entry so a tracked symlink never lets preparation edit its external target.
  await fs.rename(workspaceFile, backupFile);
  await fs.writeFile(workspaceFile, isolated);
  return {
    env: candidateEnv,
    restoreWorkspace: async () => {
      // Do not hide build/lifecycle edits from the authoritative Git clean check.
      if (
        (await fs.lstat(workspaceFile)).isFile() &&
        (await fs.readFile(workspaceFile, "utf8")) === isolated
      ) {
        await fs.rename(backupFile, workspaceFile);
      }
      await fs.rm(backupDirectory, { recursive: true, force: true });
    },
  };
}

export function shouldRunDevPreflightLint(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[DEV_PREFLIGHT_LINT_OPT_IN_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export function resolveDevPreflightLintEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...env, ...DEV_PREFLIGHT_LINT_ENV };
}
