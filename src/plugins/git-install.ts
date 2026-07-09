/** Parses, clones, verifies, and installs plugin packages from Git specs. */
import "../infra/fs-safe-defaults.js";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { sha256HexPrefix } from "../infra/crypto-digest.js";
import { pathExists } from "../infra/fs-safe.js";
import { withTempDir } from "../infra/install-source-utils.js";
import { replaceDirectoryAtomic } from "../infra/replace-file.js";
import {
  createSafeNpmInstallArgs,
  createSafeNpmInstallEnv,
} from "../infra/safe-package-install.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { resolveDefaultPluginGitDir } from "./install-paths.js";
import {
  preflightPluginGitInstallPolicy,
  type InstallSafetyOverrides,
  type InstallSecurityScanResult,
} from "./install-security-scan.js";
import {
  installPluginFromInstalledPackageDir,
  PLUGIN_INSTALL_ERROR_CODE,
  type InstallPluginResult,
} from "./install.js";
import {
  emitPluginAuditSecurityEvent,
  emitPluginInstallSecurityEvent,
  pluginAuditOutcomeForReason,
} from "./security-events.js";

const GIT_SPEC_PREFIX = "git:";
const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const FULL_GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

type PluginInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

/** Resolved Git source metadata persisted into plugin install records. */
export type GitPluginResolution = {
  url: string;
  ref?: string;
  commit?: string;
  resolvedAt: string;
};

export type GitPluginInstallResult =
  | (Extract<InstallPluginResult, { ok: true }> & { git: GitPluginResolution })
  | Extract<InstallPluginResult, { ok: false }>;

/** Normalized Git plugin install spec accepted by the Git installer. */
export type ParsedGitPluginSpec = {
  input: string;
  url: string;
  ref?: string;
  label: string;
  normalizedSpec: string;
};

/** Returns true for full commit SHAs that do not require branch/tag drift checks. */
export function isImmutableGitCommitRef(ref: string | undefined): boolean {
  return FULL_GIT_COMMIT_PATTERN.test(ref ?? "");
}

function splitGitSpecRef(input: string): { base: string; ref?: string } {
  const hashIndex = input.lastIndexOf("#");
  if (hashIndex > 0) {
    return {
      base: input.slice(0, hashIndex),
      ref: normalizeOptionalString(input.slice(hashIndex + 1)),
    };
  }

  for (
    let atIndex = input.lastIndexOf("@");
    atIndex > 0;
    atIndex = input.lastIndexOf("@", atIndex - 1)
  ) {
    const base = input.slice(0, atIndex);
    const ref = normalizeOptionalString(input.slice(atIndex + 1));
    if (ref && isGitSpecBase(base)) {
      return { base, ref };
    }
  }

  return { base: input };
}

function isGitSpecBase(value: string): boolean {
  return (
    looksLikeGitHubRepoShorthand(value) ||
    looksLikeGitHubHostPath(value) ||
    looksLikeUrlGitSpecBase(value) ||
    looksLikeScpGitUrl(value) ||
    value.endsWith(".git") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~/")
  );
}

function looksLikeGitHubRepoShorthand(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value);
}

function looksLikeGitHubHostPath(value: string): boolean {
  return /^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(value);
}

function isGitUrl(value: string): boolean {
  if (value.startsWith("-")) {
    return false;
  }
  return (
    /^(?:ssh|git|file):\/\//i.test(value) || looksLikeScpGitUrl(value) || value.endsWith(".git")
  );
}

function looksLikeScpGitUrl(value: string): boolean {
  return /^[^@\s]+@[^:\s]+:.+/.test(value);
}

function looksLikeUrlGitSpecBase(value: string): boolean {
  try {
    const url = new URL(value);
    if (!["http:", "https:", "ssh:", "git:", "file:"].includes(url.protocol)) {
      return false;
    }
    if (url.protocol === "file:") {
      return url.pathname.length > 1;
    }
    return Boolean(url.hostname) && url.pathname.length > 1;
  } catch {
    return false;
  }
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
  if (hasHttpUrlPrefix(value) || /^(?:ssh|git|file):\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return stripGitSuffix(`${url.hostname}${url.pathname}`).replace(/^\/+/, "");
    } catch {
      return stripGitSuffix(value);
    }
  }
  return stripGitSuffix(value);
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
    hasHttpUrlPrefix(base) ||
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
  return path.join(gitRoot, `git-${sha256HexPrefix(redactedSpec, 16)}`, "repo");
}

async function withGitStagingDir<T>(
  persistentRepoDir: string | undefined,
  fn: (tmpDir: string) => Promise<T>,
): Promise<T> {
  if (!persistentRepoDir) {
    return await withTempDir("openclaw-git-plugin-", fn);
  }
  const targetParent = path.dirname(persistentRepoDir);
  try {
    await fs.mkdir(targetParent, { recursive: true });
  } catch {
    return await withTempDir("openclaw-git-plugin-", fn);
  }

  let callbackStarted = false;
  try {
    return await withTempDir(
      "openclaw-git-plugin-",
      async (tmpDir) => {
        callbackStarted = true;
        return await fn(tmpDir);
      },
      { rootDir: targetParent },
    );
  } catch (err) {
    // Workspace creation can fail on read-only mounts. Never retry after the
    // callback starts, because that could clone or install dependencies twice.
    if (callbackStarted) {
      throw err;
    }
    return await withTempDir("openclaw-git-plugin-", fn);
  }
}

async function replaceManagedGitRepo(params: {
  stagedRepoDir: string;
  persistentRepoDir: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await replaceDirectoryAtomic({
      stagedDir: params.stagedRepoDir,
      targetDir: params.persistentRepoDir,
      backupPrefix: ".repo-backup-",
    });
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

function buildBlockedGitInstallResult(params: {
  blocked: NonNullable<NonNullable<InstallSecurityScanResult>["blocked"]>;
}): Extract<InstallPluginResult, { ok: false }> {
  return {
    ok: false,
    error: params.blocked.reason,
    ...(params.blocked.code === "security_scan_failed"
      ? { code: PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_FAILED }
      : params.blocked.code === "security_scan_blocked"
        ? { code: PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED }
        : {}),
  };
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
  const effectiveMode =
    params.mode === "update" && (await pathExists(persistentRepoDir)) ? "update" : "install";
  const stagingRepoDir = params.dryRun ? undefined : persistentRepoDir;
  return await withGitStagingDir(stagingRepoDir, async (tmpDir) => {
    const repoDir = path.join(tmpDir, "repo");
    params.logger?.info?.(
      `Cloning ${sanitizeForLog(redactSensitiveUrlLikeString(parsed.label))}...`,
    );
    const cloneArgs = parsed.ref
      ? ["git", "clone", "--", parsed.url, repoDir]
      : ["git", "clone", "--depth", "1", "--", parsed.url, repoDir];
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
        argv: ["git", "switch", "--detach", "--", parsed.ref],
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

    const installPolicyRequest = {
      kind: "plugin-git" as const,
      requestedSpecifier: parsed.input,
      source: {
        kind: "git" as const,
        authority: "third-party" as const,
        mutable: !isImmutableGitCommitRef(parsed.ref),
        network: true,
      },
    };
    const preflight = await preflightPluginGitInstallPolicy({
      config: params.config,
      logger: params.logger ?? {},
      mode: effectiveMode,
      pluginId: params.expectedPluginId ?? parsed.label,
      requestedSpecifier: parsed.input,
      source: installPolicyRequest.source,
      sourcePath: repoDir,
    });
    if (preflight?.blocked) {
      const reason =
        preflight.blocked.code === "security_scan_failed"
          ? "security_scan_failed"
          : "security_scan_blocked";
      emitPluginAuditSecurityEvent({
        outcome: pluginAuditOutcomeForReason(reason),
        reason,
        pluginId: params.expectedPluginId,
        mode: effectiveMode,
        sourceFamily: "git",
      });
      return buildBlockedGitInstallResult({ blocked: preflight.blocked });
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
          env: createSafeNpmInstallEnv(process.env, {
            npmConfigCwd: repoDir,
            packageLock: true,
            quiet: true,
          }),
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
      config: params.config,
      packageDir: repoDir,
      dryRun: params.dryRun,
      expectedPluginId: params.expectedPluginId,
      logger: params.logger,
      mode: effectiveMode,
      emitSuccessSecurityEvent: false,
      installPolicyRequest,
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
      emitPluginInstallSecurityEvent({
        pluginId: result.pluginId,
        mode: effectiveMode,
        sourceFamily: "git",
        extensionCount: result.extensions.length,
        hasVersion: Boolean(result.version),
        trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
      });
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
