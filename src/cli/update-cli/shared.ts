// Shared update command primitives for channel resolution, install roots, and subprocess steps.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { hasErrnoCode } from "../../infra/errors.js";
import { resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { readPackageName, readPackageVersion } from "../../infra/package-json.js";
import { normalizePackageTagInput } from "../../infra/package-tag.js";
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
import { runStep } from "../../infra/update-runner-command.js";
import type { UpdateStepProgress, UpdateStepResult } from "../../infra/update-runner.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { pathExists } from "../../utils.js";
import { COMPLETION_SKIP_PLUGIN_COMMANDS_ENV } from "../completion-runtime.js";
import { isJsonOutputModeActive } from "../json-output-mode.js";

export type UpdateCommandOptions = {
  acceptCapabilities?: boolean;
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

export type UpdateFinalizeOptions = {
  acceptCapabilities?: boolean;
  json?: boolean;
  channel?: string;
  timeout?: string;
  yes?: boolean;
  restart?: boolean;
  /** Internal external-supervisor handshake; public repair always leaves this false. */
  deferCompletionCache?: boolean;
};

export type UpdateWizardOptions = {
  acceptCapabilities?: boolean;
  timeout?: string;
};

const INVALID_TIMEOUT_ERROR = "--timeout must be a positive integer (seconds)";
const MAX_SAFE_TIMEOUT_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

/** Parse a CLI timeout in seconds, exiting through the runtime on invalid input. */
export function parseTimeoutMsOrExit(timeout?: string): number | undefined | null {
  if (timeout === undefined) {
    return undefined;
  }
  const trimmed = timeout.trim();
  const seconds = parseStrictPositiveInteger(trimmed);
  if (seconds === undefined || seconds > MAX_SAFE_TIMEOUT_SECONDS) {
    if (isJsonOutputModeActive(process.argv)) {
      throw new Error(INVALID_TIMEOUT_ERROR);
    }
    defaultRuntime.error(INVALID_TIMEOUT_ERROR);
    defaultRuntime.exit(1);
    return null;
  }
  return seconds * 1000;
}

const OPENCLAW_REPO_URL = "https://github.com/openclaw/openclaw.git";
// Keep the full commit graph for dev ref switching while deferring historical blobs.
// A shallow clone would make older or non-default dev targets unreachable.
const GIT_CLONE_BLOB_FILTER = "--filter=blob:none";

export const DEFAULT_PACKAGE_NAME = "openclaw";
const CORE_PACKAGE_NAMES = new Set([DEFAULT_PACKAGE_NAME]);

/** Normalize a CLI tag/version/spec into the npm target form accepted by update flows. */
export function normalizeTag(value?: string | null): string | null {
  return normalizePackageTagInput(value, ["openclaw", DEFAULT_PACKAGE_NAME]);
}

function normalizeVersionTag(tag: string): string | null {
  const trimmed = tag.trim();
  if (!trimmed) {
    return null;
  }
  const cleaned = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
  return parseSemver(cleaned) ? cleaned : null;
}

export { readPackageName, readPackageVersion };

/** Resolve an npm dist-tag or explicit version into a concrete package version. */
export async function resolveTargetVersion(
  tag: string,
  timeoutMs?: number,
  options: { spec?: string; command?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  if (!canResolveRegistryVersionForPackageTarget(tag)) {
    return null;
  }
  const direct = normalizeVersionTag(tag);
  if (direct) {
    return direct;
  }
  const res = await fetchNpmTagVersion({
    tag,
    timeoutMs,
    spec: options.spec,
    command: options.command,
    cwd: options.cwd,
    env: options.env,
  });
  return res.version ?? null;
}

/** Return true when `root` is a local git checkout directory. */
export async function isGitCheckout(root: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isCorePackage(root: string): Promise<boolean> {
  const name = await readPackageName(root);
  return Boolean(name && CORE_PACKAGE_NAMES.has(name));
}

/** Return true only for existing directories with no entries. */
export async function isEmptyDir(targetPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(targetPath);
    return entries.length === 0;
  } catch {
    return false;
  }
}

/** Resolve the checkout path used by source-based self-update. */
export function resolveGitInstallDir(): string {
  const override = process.env.OPENCLAW_GIT_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return resolveDefaultGitDir();
}

function resolveDefaultGitDir(): string {
  const home = resolveRequiredHomeDir(process.env, os.homedir);
  if (home.startsWith("/")) {
    return path.posix.join(home, "openclaw");
  }
  return path.join(home, "openclaw");
}

/** Prefer the current Node executable, falling back to `node` when run through another shim. */
export function resolveNodeRunner(): string {
  const base = normalizeLowercaseStringOrEmpty(path.basename(process.execPath));
  if (base === "node" || base === "node.exe") {
    return process.execPath;
  }
  return "node";
}

export function tryResolveInvocationCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

/** Locate the installed OpenClaw package root that should receive update operations. */
export async function resolveUpdateRoot(): Promise<string> {
  // Preserve the lexical package path from the invoking shim. pnpm 11 package
  // modules realpath into a shared store, which is not the install owner.
  const invocationRoot = process.argv[1]
    ? await resolveOpenClawPackageRoot({ cwd: path.dirname(path.resolve(process.argv[1])) })
    : null;
  return (
    invocationRoot ??
    (await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url, cwd: process.cwd() })) ??
    process.cwd()
  );
}

/** Run one update subprocess and report bounded stdout/stderr tails to progress listeners. */
export async function runUpdateStep(params: {
  name: string;
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  progress?: UpdateStepProgress;
  env?: NodeJS.ProcessEnv;
}): Promise<UpdateStepResult> {
  return await runStep({
    ...params,
    cwd: params.cwd ?? process.cwd(),
    runCommand: runCommandWithTimeout,
    stepIndex: 0,
    totalSteps: 0,
  });
}

type GitCheckoutResult = {
  checkoutDir: string;
  step: UpdateStepResult | null;
};

async function cloneGitCheckoutTransactionally(params: {
  dir: string;
  timeoutMs: number;
  progress?: UpdateStepProgress;
  env?: NodeJS.ProcessEnv;
}): Promise<GitCheckoutResult> {
  const parentDir = path.dirname(params.dir);
  await fs.mkdir(parentDir, { recursive: true });
  const canonicalParentDir = await fs.realpath(parentDir);
  const preserveDir = (await pathExists(params.dir)) && (await isEmptyDir(params.dir));
  const targetDir = preserveDir
    ? await fs.realpath(params.dir)
    : path.join(canonicalParentDir, path.basename(params.dir));
  const stagingParent = preserveDir ? targetDir : canonicalParentDir;
  const stagingDir = await fs.mkdtemp(path.join(stagingParent, ".openclaw-clone-"));
  let cleanupStaging = true;

  try {
    const result = await runUpdateStep({
      name: "git clone",
      argv: ["git", "clone", GIT_CLONE_BLOB_FILTER, OPENCLAW_REPO_URL, stagingDir],
      env: params.env,
      timeoutMs: params.timeoutMs,
      progress: params.progress,
    });
    if (result.exitCode !== 0) {
      return { checkoutDir: targetDir, step: result };
    }

    if (!preserveDir) {
      try {
        await fs.lstat(targetDir);
      } catch (error) {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        await fs.rename(stagingDir, targetDir);
        return { checkoutDir: targetDir, step: result };
      }
    }

    if (!preserveDir) {
      throw new Error(
        `OPENCLAW_GIT_DIR appeared while cloning: ${params.dir}. The existing path was left unchanged; move it or choose another OPENCLAW_GIT_DIR, then retry.`,
      );
    }

    const expectedEntries = preserveDir ? [path.basename(stagingDir)] : [];
    const destinationEntries = await fs.readdir(targetDir);
    if (destinationEntries.toSorted().join("\0") !== expectedEntries.toSorted().join("\0")) {
      throw new Error(
        `OPENCLAW_GIT_DIR appeared while cloning: ${params.dir}. The existing path was left unchanged; move it or choose another OPENCLAW_GIT_DIR, then retry.`,
      );
    }

    const entries = (await fs.readdir(stagingDir)).toSorted((a, b) =>
      a === ".git" ? 1 : b === ".git" ? -1 : 0,
    );
    const moved: string[] = [];
    let publishError: { value: unknown } | undefined;
    try {
      for (const entry of entries) {
        await fs.rename(path.join(stagingDir, entry), path.join(targetDir, entry));
        moved.push(entry);
      }
    } catch (error) {
      publishError = { value: error };
    }
    if (publishError) {
      const rollbackErrors: unknown[] = [];
      for (const entry of moved.toReversed()) {
        try {
          await fs.rename(path.join(targetDir, entry), path.join(stagingDir, entry));
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        cleanupStaging = false;
        throw new AggregateError(
          [publishError.value, ...rollbackErrors],
          `Could not publish or fully roll back the cloned checkout at ${targetDir}; recovery files remain at ${stagingDir}`,
        );
      }
      throw publishError.value;
    }
    return { checkoutDir: targetDir, step: result };
  } finally {
    if (cleanupStaging) {
      await fs.rm(stagingDir, { recursive: true, force: true });
    }
  }
}

/** Ensure the configured source-update directory exists and points at an OpenClaw checkout. */
export async function ensureGitCheckout(params: {
  dir: string;
  timeoutMs: number;
  progress?: UpdateStepProgress;
  env?: NodeJS.ProcessEnv;
}): Promise<GitCheckoutResult> {
  const gitEnv = params.env ?? (await createGlobalInstallEnv());
  const dirExists = await pathExists(params.dir);
  if (!dirExists) {
    return await cloneGitCheckoutTransactionally({
      dir: params.dir,
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

    return await cloneGitCheckoutTransactionally({
      dir: params.dir,
      env: gitEnv,
      timeoutMs: params.timeoutMs,
      progress: params.progress,
    });
  }

  if (!(await isCorePackage(params.dir))) {
    throw new Error(`OPENCLAW_GIT_DIR does not look like a core checkout: ${params.dir}.`);
  }

  return { checkoutDir: await fs.realpath(params.dir), step: null };
}

/** Detect the package manager that owns a global/package OpenClaw install. */
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
const COMPLETION_CACHE_MANUAL_REFRESH_HINT =
  "Shell tab-completion may be stale; refresh manually with: openclaw completion --write-state";

/** Best-effort refresh of shell completion state after a successful update. */
export async function tryWriteCompletionCache(
  root: string,
  jsonMode: boolean,
): Promise<"completed" | "failed" | "skipped"> {
  const binPath = path.join(root, "openclaw.mjs");
  if (!(await pathExists(binPath))) {
    return "skipped";
  }

  const result = spawnSync(resolveNodeRunner(), [binPath, "completion", "--write-state"], {
    cwd: root,
    env: {
      ...process.env,
      [COMPLETION_SKIP_PLUGIN_COMMANDS_ENV]: "1",
    },
    encoding: "utf-8",
    timeout: COMPLETION_CACHE_WRITE_TIMEOUT_MS,
  });

  if (result.error) {
    if (!jsonMode) {
      const err = result.error as NodeJS.ErrnoException;
      const reason =
        err.code === "ETIMEDOUT"
          ? `timed out after ${COMPLETION_CACHE_WRITE_TIMEOUT_MS / 1000}s`
          : String(result.error);
      defaultRuntime.log(
        theme.warn(
          `Completion cache update failed: ${reason}. ${COMPLETION_CACHE_MANUAL_REFRESH_HINT}`,
        ),
      );
    }
    return "failed";
  }

  if (result.status !== 0) {
    if (!jsonMode) {
      const stderr = (result.stderr ?? "").trim();
      const detail = stderr ? ` (${stderr})` : "";
      defaultRuntime.log(
        theme.warn(
          `Completion cache update failed${detail}. ${COMPLETION_CACHE_MANUAL_REFRESH_HINT}`,
        ),
      );
    }
    return "failed";
  }
  return "completed";
}

/** Adapter used by global-install detection helpers to execute bounded subprocess probes. */
export function createGlobalCommandRunner(): CommandRunner {
  return async (argv, options) => {
    const res = await runCommandWithTimeout(argv, options);
    return { stdout: res.stdout, stderr: res.stderr, code: res.code };
  };
}
