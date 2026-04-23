import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { readPackageName, readPackageVersion } from "../../infra/package-json.js";
import { normalizePackageTagInput } from "../../infra/package-tag.js";
import { trimLogTail } from "../../infra/restart-sentinel.js";
import { parseSemver } from "../../infra/runtime-guard.js";
import { fetchNpmTagVersion } from "../../infra/update-check.js";
import {
  canResolveRegistryVersionForPackageTarget,
  createGlobalInstallEnv,
  detectGlobalInstallManagerByPresence,
  detectGlobalInstallManagerForRoot,
  type CommandRunner,
  type GlobalInstallManager,
} from "../../infra/update-global.js";
import type { UpdateStepProgress, UpdateStepResult } from "../../infra/update-runner.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { theme } from "../../terminal/theme.js";
import { pathExists } from "../../utils.js";

export type UpdateCommandOptions = {
  json?: boolean;
  restart?: boolean;
  dryRun?: boolean;
  channel?: string;
  tag?: string;
  timeout?: string;
  yes?: boolean;
};

export type UpdateStatusOptions = {
  json?: boolean;
  timeout?: string;
};

export type UpdateWizardOptions = {
  timeout?: string;
};

const INVALID_TIMEOUT_ERROR = "--timeout must be a positive integer (seconds)";

export function parseTimeoutMsOrExit(timeout?: string): number | undefined | null {
  const timeoutMs = timeout ? Number.parseInt(timeout, 10) * 1000 : undefined;
  if (timeoutMs !== undefined && (Number.isNaN(timeoutMs) || timeoutMs <= 0)) {
    defaultRuntime.error(INVALID_TIMEOUT_ERROR);
    defaultRuntime.exit(1);
    return null;
  }
  return timeoutMs;
}

const OPENCLAW_REPO_URL = "https://github.com/openclaw/openclaw.git";
const MAX_LOG_CHARS = 8000;

export const DEFAULT_PACKAGE_NAME = "openclaw";
const CORE_PACKAGE_NAMES = new Set([DEFAULT_PACKAGE_NAME]);

export function normalizeTag(value?: string | null): string | null {
  return normalizePackageTagInput(value, ["openclaw", DEFAULT_PACKAGE_NAME]);
}

export function normalizeVersionTag(tag: string): string | null {
  const trimmed = tag.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  return parseSemver(cleaned) ? cleaned : null;
}

export { readPackageName, readPackageVersion };

export async function resolveTargetVersion(
  tag: string,
  timeoutMs?: number,
): Promise<string | null> {
  if (!canResolveRegistryVersionForPackageTarget(tag)) {
    return null;
  }
  const direct = normalizeVersionTag(tag);
  if (direct) {
    return direct;
  }
  const res = await fetchNpmTagVersion({ tag, timeoutMs });
  return res.version ?? null;
}

export async function isGitCheckout(root: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function isCorePackage(root: string): Promise<boolean> {
  const name = await readPackageName(root);
  return Boolean(name && CORE_PACKAGE_NAMES.has(name));
}

export async function isEmptyDir(targetPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(targetPath);
    return entries.length === 0;
  } catch {
    return false;
  }
}

export function resolveGitInstallDir(): string {
  const override = process.env.OPENCLAW_GIT_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return resolveDefaultGitDir();
}

function resolveDefaultGitDir(): string {
  const home = os.homedir();
  if (home.startsWith("/")) {
    return path.posix.join(home, "openclaw");
  }
  return path.join(home, "openclaw");
}

export function resolveNodeRunner(): string {
  const base = normalizeLowercaseStringOrEmpty(path.basename(process.execPath));
  if (base === "node" || base === "node.exe") {
    return process.execPath;
  }
  return "node";
}

export async function resolveUpdateRoot(): Promise<string> {
  return (
    (await resolveOpenClawPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })) ?? process.cwd()
  );
}

export async function runUpdateStep(params: {
  name: string;
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  progress?: UpdateStepProgress;
  env?: NodeJS.ProcessEnv;
}): Promise<UpdateStepResult> {
  const command = params.argv.join(" ");
  params.progress?.onStepStart?.({
    name: params.name,
    command,
    index: 0,
    total: 0,
  });

  const started = Date.now();
  const res = await runCommandWithTimeout(params.argv, {
    cwd: params.cwd,
    env: params.env,
    timeoutMs: params.timeoutMs,
  });
  const durationMs = Date.now() - started;
  const stderrTail = trimLogTail(res.stderr, MAX_LOG_CHARS);

  params.progress?.onStepComplete?.({
    name: params.name,
    command,
    index: 0,
    total: 0,
    durationMs,
    exitCode: res.code,
    stderrTail,
  });

  return {
    name: params.name,
    command,
    cwd: params.cwd ?? process.cwd(),
    durationMs,
    exitCode: res.code,
    stdoutTail: trimLogTail(res.stdout, MAX_LOG_CHARS),
    stderrTail,
  };
}

export async function ensureGitCheckout(params: {
  dir: string;
  timeoutMs: number;
  progress?: UpdateStepProgress;
  env?: NodeJS.ProcessEnv;
}): Promise<UpdateStepResult | null> {
  const gitEnv = params.env ?? (await createGlobalInstallEnv());
  const dirExists = await pathExists(params.dir);
  if (!dirExists) {
    return await runUpdateStep({
      name: "git clone",
      argv: ["git", "clone", OPENCLAW_REPO_URL, params.dir],
      env: gitEnv,
      timeoutMs: params.timeoutMs,
      progress: params.progress,
    });
  }

  if (!(await isGitCheckout(params.dir))) {
    const empty = await isEmptyDir(params.dir);
    if (!empty) {
      throw new Error(
        `OPENCLAW_GIT_DIR points at a non-git directory: ${params.dir}. Set OPENCLAW_GIT_DIR to an empty folder or an openclaw checkout.`,
      );
    }

    return await runUpdateStep({
      name: "git clone",
      argv: ["git", "clone", OPENCLAW_REPO_URL, params.dir],
      cwd: params.dir,
      env: gitEnv,
      timeoutMs: params.timeoutMs,
      progress: params.progress,
    });
  }

  if (!(await isCorePackage(params.dir))) {
    throw new Error(`OPENCLAW_GIT_DIR does not look like a core checkout: ${params.dir}.`);
  }

  return null;
}

export async function resolveGlobalManager(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  timeoutMs: number;
}): Promise<GlobalInstallManager> {
  const runCommand = createGlobalCommandRunner();

  if (params.installKind === "package") {
    const detected = await detectGlobalInstallManagerForRoot(
      runCommand,
      params.root,
      params.timeoutMs,
    );
    if (detected) {
      return detected;
    }
  }

  const byPresence = await detectGlobalInstallManagerByPresence(runCommand, params.timeoutMs);
  return byPresence ?? "npm";
}

const COMPLETION_CACHE_WRITE_TIMEOUT_MS = 30_000;

export async function tryWriteCompletionCache(root: string, jsonMode: boolean): Promise<void> {
  const binPath = path.join(root, "openclaw.mjs");
  if (!(await pathExists(binPath))) {
    return;
  }

  const result = spawnSync(resolveNodeRunner(), [binPath, "completion", "--write-state"], {
    cwd: root,
    env: process.env,
    encoding: "utf-8",
    timeout: COMPLETION_CACHE_WRITE_TIMEOUT_MS,
  });

  if (result.error) {
    if (!jsonMode) {
      defaultRuntime.log(theme.warn(`Completion cache update failed: ${String(result.error)}`));
    }
    return;
  }

  if (result.status !== 0 && !jsonMode) {
    const stderr = (result.stderr ?? "").trim();
    const detail = stderr ? ` (${stderr})` : "";
    defaultRuntime.log(theme.warn(`Completion cache update failed${detail}.`));
  }
}

export function createGlobalCommandRunner(): CommandRunner {
  return async (argv, options) => {
    const res = await runCommandWithTimeout(argv, options);
    return { stdout: res.stdout, stderr: res.stderr, code: res.code };
  };
}
