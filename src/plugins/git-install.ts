import { withTempDir } from "../infra/install-source-utils.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveUserPath } from "../utils.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import { installPluginFromDir, type InstallPluginResult } from "./install.js";

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

function formatGitCommandFailure(params: {
  action: string;
  source: ParsedGitPluginSpec;
  stdout: string;
  stderr: string;
}): string {
  const detail = sanitizeForLog(params.stderr.trim() || params.stdout.trim() || "git failed");
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

  return await withTempDir("openclaw-git-plugin-", async (tmpDir) => {
    const repoDir = `${tmpDir}/repo`;
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

    const result = await installPluginFromDir({
      dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
      dirPath: repoDir,
      dryRun: params.dryRun,
      expectedPluginId: params.expectedPluginId,
      extensionsDir: params.extensionsDir,
      logger: params.logger,
      mode: params.mode,
      timeoutMs: params.timeoutMs,
      installPolicyRequest: {
        kind: "plugin-git",
        requestedSpecifier: parsed.input,
      },
    });
    if (!result.ok) {
      return result;
    }

    return {
      ...result,
      git: {
        url: parsed.url,
        ref: parsed.ref,
        commit: normalizeOptionalString(rev.stdout),
        resolvedAt: new Date().toISOString(),
      },
    };
  });
}
