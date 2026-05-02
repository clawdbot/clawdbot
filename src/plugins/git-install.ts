import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "../infra/install-source-utils.js";
import {
  createSafeNpmInstallArgs,
  createSafeNpmInstallEnv,
} from "../infra/safe-package-install.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveUserPath } from "../utils.js";
import { resolveDefaultPluginGitDir } from "./install-paths.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import { installPluginFromInstalledPackageDir, type InstallPluginResult } from "./install.js";

const GIT_SPEC_PREFIX = "git:";
const DEFAULT_GIT_TIMEOUT_MS = 120_000;

type PluginInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type GitPluginResolution = {
  url: string;
  ref?: string;
  commit?: string;
  resolvedAt: string;
};

export type GitPluginInstallResult =
  | (Extract<InstallPluginResult, { ok: true }> & { git: GitPluginResolution })
  | Extract<InstallPluginResult, { ok: false }>;

export type ParsedGitPluginSpec = {
  input: string;
  url: string;
  ref?: string;
  label: string;
  normalizedSpec: string;
};

function splitGitSpecRef(input: string): { base: string; ref?: string } {
  const hashIndex = input.lastIndexOf("#");
  if (hashIndex > 0) {
    return {
      base: input.slice(0, hashIndex),
      ref: normalizeOptionalString(input.slice(hashIndex + 1)),
    };
  }

  const atIndex = input.lastIndexOf("@");
  const lastSlashIndex = Math.max(input.lastIndexOf("/"), input.lastIndexOf("\\"));
  if (atIndex > lastSlashIndex && atIndex > 0) {
    return {
      base: input.slice(0, atIndex),
      ref: normalizeOptionalString(input.slice(atIndex + 1)),
    };
  }

  return { base: input };
}

function looksLikeGitHubRepoShorthand(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value);
}

function looksLikeGitHubHostPath(value: string): boolean {
  return /^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(value);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isGitUrl(value: string): boolean {
  return (
    /^(?:ssh|git|file):\/\//i.test(value) ||
    /^[^@\s]+@[^:\s]+:.+/.test(value) ||
    value.endsWith(".git")
  );
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/i, "");
}

function normalizeGitHubRepo(value: string): { url: string; label: string } {
  const repo = stripGitSuffix(value.replace(/^github\.com\//i, ""));
  return {
    url: `https://github.com/${repo}.git`,
    label: repo,
  };
}

function normalizeGitLabel(value: string): string {
  if (isHttpUrl(value) || /^(?:ssh|git|file):\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return stripGitSuffix(`${url.hostname}${url.pathname}`).replace(/^\/+/, "");
    } catch {
      return value;
    }
  }
  return value;
}

export function parseGitPluginSpec(raw: string): ParsedGitPluginSpec | null {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(GIT_SPEC_PREFIX)) {
    return null;
  }

  const body = trimmed.slice(GIT_SPEC_PREFIX.length).trim();
  if (!body) {
    return null;
  }

  const split = splitGitSpecRef(body);
  const base = split.base.trim();
  if (!base) {
    return null;
  }

  if (looksLikeGitHubRepoShorthand(base) || looksLikeGitHubHostPath(base)) {
    const normalized = normalizeGitHubRepo(base);
    return {
      input: trimmed,
      url: normalized.url,
      ref: split.ref,
      label: normalized.label,
      normalizedSpec: `${GIT_SPEC_PREFIX}${normalized.url}${split.ref ? `@${split.ref}` : ""}`,
    };
  }

  if (
    isHttpUrl(base) ||
    isGitUrl(base) ||
    base.startsWith("./") ||
    base.startsWith("../") ||
    base.startsWith("~/")
  ) {
    const url =
      base.startsWith("./") || base.startsWith("../") || base.startsWith("~/")
        ? resolveUserPath(base)
        : base;
    return {
      input: trimmed,
      url,
      ref: split.ref,
      label: normalizeGitLabel(url),
      normalizedSpec: `${GIT_SPEC_PREFIX}${url}${split.ref ? `@${split.ref}` : ""}`,
    };
  }

  return null;
}

function createGitCommandEnv(): NodeJS.ProcessEnv {
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: "",
    GIT_EDITOR: "",
    GIT_SEQUENCE_EDITOR: "",
    GIT_EXTERNAL_DIFF: "",
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_NAMESPACE: undefined,
    GIT_EXEC_PATH: undefined,
    GIT_SSL_NO_VERIFY: undefined,
  };
}

function resolveGitInstallRepoDir(params: {
  gitDir?: string;
  source: ParsedGitPluginSpec;
}): string {
  const gitRoot = params.gitDir ? resolveUserPath(params.gitDir) : resolveDefaultPluginGitDir();
  const redactedSpec = redactSensitiveUrlLikeString(params.source.normalizedSpec);
  const hash = createHash("sha256").update(redactedSpec).digest("hex").slice(0, 16);
  return path.join(gitRoot, `git-${hash}`, "repo");
}

async function replaceManagedGitRepo(params: {
  stagedRepoDir: string;
  persistentRepoDir: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const parentDir = path.dirname(params.persistentRepoDir);
  const backupDir = path.join(parentDir, `.repo-backup-${process.pid}-${Date.now()}`);
  let backupCreated = false;

  try {
    await fs.mkdir(parentDir, { recursive: true });
    try {
      await fs.rename(params.persistentRepoDir, backupDir);
      backupCreated = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }

    try {
      await fs.rename(params.stagedRepoDir, params.persistentRepoDir);
    } catch (err) {
      if (backupCreated) {
        await fs.rename(backupDir, params.persistentRepoDir);
        backupCreated = false;
      }
      throw err;
    }

    if (backupCreated) {
      await fs.rm(backupDir, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `failed to replace managed git plugin repository: ${String(err)}`,
    };
  }
}

function formatGitCommandFailure(params: {
  action: string;
  source: ParsedGitPluginSpec;
  stdout: string;
  stderr: string;
}): string {
  const detail = sanitizeForLog(
    redactSensitiveUrlLikeString(params.stderr.trim() || params.stdout.trim() || "git failed"),
  );
  return `failed to ${params.action} ${sanitizeForLog(redactSensitiveUrlLikeString(params.source.label))}: ${detail}`;
}

async function runGitCommand(params: {
  argv: string[];
  action: string;
  source: ParsedGitPluginSpec;
  cwd?: string;
  timeoutMs?: number;
}): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const result = await runCommandWithTimeout(params.argv, {
    cwd: params.cwd,
    timeoutMs: params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    env: createGitCommandEnv(),
  });
  if (result.code !== 0) {
    return {
      ok: false,
      error: formatGitCommandFailure({
        action: params.action,
        source: params.source,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    };
  }
  return { ok: true, stdout: result.stdout };
}

export async function installPluginFromGitSpec(
  params: InstallSafetyOverrides & {
    spec: string;
    extensionsDir?: string;
    gitDir?: string;
    timeoutMs?: number;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
  },
): Promise<GitPluginInstallResult> {
  const parsed = parseGitPluginSpec(params.spec);
  if (!parsed) {
    return {
      ok: false,
      error: `unsupported git: plugin spec: ${params.spec}`,
    };
  }

  const persistentRepoDir = resolveGitInstallRepoDir({ gitDir: params.gitDir, source: parsed });
  return await withTempDir("openclaw-git-plugin-", async (tmpDir) => {
    const repoDir = path.join(tmpDir, "repo");
    params.logger?.info?.(
      `Cloning ${sanitizeForLog(redactSensitiveUrlLikeString(parsed.label))}...`,
    );
    const cloneArgs = parsed.ref
      ? ["git", "clone", parsed.url, repoDir]
      : ["git", "clone", "--depth", "1", parsed.url, repoDir];
    const clone = await runGitCommand({
      argv: cloneArgs,
      action: "clone",
      source: parsed,
      timeoutMs: params.timeoutMs,
    });
    if (!clone.ok) {
      return clone;
    }

    if (parsed.ref) {
      const checkout = await runGitCommand({
        argv: ["git", "checkout", "--detach", parsed.ref],
        action: `checkout ${parsed.ref}`,
        source: parsed,
        cwd: repoDir,
        timeoutMs: params.timeoutMs,
      });
      if (!checkout.ok) {
        return checkout;
      }
    }

    const rev = await runGitCommand({
      argv: ["git", "rev-parse", "HEAD"],
      action: "resolve commit for",
      source: parsed,
      cwd: repoDir,
      timeoutMs: params.timeoutMs,
    });
    if (!rev.ok) {
      return rev;
    }

    if (!params.dryRun) {
      params.logger?.info?.("Installing plugin dependencies with npm…");
      const install = await runCommandWithTimeout(
        [
          "npm",
          ...createSafeNpmInstallArgs({
            omitDev: true,
            loglevel: "error",
            noAudit: true,
            noFund: true,
          }),
        ],
        {
          cwd: repoDir,
          timeoutMs: Math.max(params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, 300_000),
          env: createSafeNpmInstallEnv(process.env, { packageLock: true, quiet: true }),
        },
      );
      if (install.code !== 0) {
        return {
          ok: false,
          error: `npm install failed: ${install.stderr.trim() || install.stdout.trim()}`,
        };
      }
    }

    const result = await installPluginFromInstalledPackageDir({
      dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
      packageDir: repoDir,
      dryRun: params.dryRun,
      expectedPluginId: params.expectedPluginId,
      logger: params.logger,
      mode: params.mode,
      installPolicyRequest: {
        kind: "plugin-git",
        requestedSpecifier: parsed.input,
      },
    });
    if (!result.ok) {
      return result;
    }
    if (!params.dryRun) {
      const replaceResult = await replaceManagedGitRepo({
        stagedRepoDir: repoDir,
        persistentRepoDir,
      });
      if (!replaceResult.ok) {
        return replaceResult;
      }
    }

    return {
      ...result,
      targetDir: params.dryRun ? result.targetDir : persistentRepoDir,
      git: {
        url: parsed.url,
        ref: parsed.ref,
        commit: normalizeOptionalString(rev.stdout),
        resolvedAt: new Date().toISOString(),
      },
    };
  });
}
