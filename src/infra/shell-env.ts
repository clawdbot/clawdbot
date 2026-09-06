// Loads shell-derived environment variables for provider and command runtimes.
import { type ExecFileSyncOptionsWithBufferEncoding, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseStrictNonNegativeInteger,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { isTruthyEnvValue } from "./env.js";
import { formatErrorMessage } from "./errors.js";
import { resolveExecutableFromPathEnv } from "./executable-path.js";
import { sanitizeHostExecEnv } from "./host-env-security.js";
import { pruneMapToMaxSize } from "./map-size.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_SHELL = "/bin/sh";
const LOGIN_SHELL_ENV_COMMAND = "printf '\\0'; env -0";
let lastAppliedKeys: string[] = [];
let cachedShellPath: string | null | undefined;
let cachedEtcShells: Set<string> | null | undefined;
let nextExecCacheId = 1;
const loginShellEnvProbeCache = new Map<string, Array<[string, string]>>();
const LOGIN_SHELL_ENV_CACHE_LIMIT = 64;
const execCacheIds = new WeakMap<object, number>();
type LoginShellEnvProbePurpose = "environment-import" | "path";

function resolveShellExecEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const execEnv = sanitizeHostExecEnv({ baseEnv: env });

  // Startup-file resolution must stay pinned to the real user home.
  const home = os.homedir().trim();
  if (home) {
    execEnv.HOME = home;
  } else {
    delete execEnv.HOME;
  }

  // Avoid zsh startup-file redirection via env poisoning.
  delete execEnv.ZDOTDIR;
  return execEnv;
}

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  return resolveTimerTimeoutMs(timeoutMs, DEFAULT_TIMEOUT_MS, 0);
}

function readEtcShells(): Set<string> | null {
  if (cachedEtcShells !== undefined) {
    return cachedEtcShells;
  }
  try {
    const raw = fs.readFileSync("/etc/shells", "utf8");
    const entries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && path.isAbsolute(line));
    cachedEtcShells = new Set(entries);
  } catch {
    cachedEtcShells = null;
  }
  return cachedEtcShells;
}

function isTrustedShellPath(shell: string): boolean {
  if (!path.isAbsolute(shell)) {
    return false;
  }
  const normalized = path.normalize(shell);
  if (normalized !== shell) {
    return false;
  }

  // Primary trust anchor: shell registered in /etc/shells.
  const registeredShells = readEtcShells();
  return registeredShells?.has(shell) === true;
}

function resolveShell(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL?.trim();
  if (shell && isTrustedShellPath(shell)) {
    return shell;
  }
  return DEFAULT_SHELL;
}

function execLoginShellEnvZero(params: {
  shell: string;
  env: NodeJS.ProcessEnv;
  exec: typeof execFileSync;
  timeoutMs: number;
  purpose: LoginShellEnvProbePurpose;
}): Buffer {
  // Explicit imports reproduce the user's interactive Bash startup; PATH discovery must not run
  // interactive startup files during ordinary command execution.
  const useInteractiveBash =
    params.purpose === "environment-import" && path.basename(params.shell) === "bash";
  const args = useInteractiveBash
    ? ["-lic", LOGIN_SHELL_ENV_COMMAND]
    : ["-l", "-c", LOGIN_SHELL_ENV_COMMAND];
  // Interactive Bash must not take the CLI's controlling terminal. execFileSync forwards
  // detached to spawnSync, but its options type omits it.
  const options: ExecFileSyncOptionsWithBufferEncoding & { detached: boolean } = {
    encoding: "buffer",
    timeout: params.timeoutMs,
    maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
    env: params.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  };
  return params.exec(params.shell, args, options);
}

function parseShellEnv(stdout: Buffer): Map<string, string> {
  const shellEnv = new Map<string, string>();
  // Startup files may write banners before our command. The leading NUL frames the env payload
  // so that banner text cannot become part of its first key.
  const frameEnd = stdout.indexOf(0);
  if (frameEnd < 0) {
    return shellEnv;
  }
  const parts = stdout
    .subarray(frameEnd + 1)
    .toString("utf8")
    .split("\0");
  for (const part of parts) {
    if (!part) {
      continue;
    }
    const eq = part.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (!key) {
      continue;
    }
    shellEnv.set(key, value);
  }
  return shellEnv;
}

function resolveExecCacheId(exec: typeof execFileSync | undefined): string {
  if (!exec) {
    return "default";
  }
  const key = exec as object;
  let id = execCacheIds.get(key);
  if (!id) {
    id = nextExecCacheId;
    nextExecCacheId += 1;
    execCacheIds.set(key, id);
  }
  return `exec:${id}`;
}

function createLoginShellEnvCacheKey(params: {
  shell: string;
  timeoutMs: number;
  exec?: typeof execFileSync;
  execEnv: NodeJS.ProcessEnv;
  purpose: LoginShellEnvProbePurpose;
}): string {
  const startupEnvEntries = Object.entries(params.execEnv)
    .filter(([key]) => {
      if (
        key === "HOME" ||
        key === "PATH" ||
        key === "TERM" ||
        key === "LANG" ||
        key === "LC_ALL" ||
        key === "LC_CTYPE" ||
        key === "USER" ||
        key === "LOGNAME" ||
        key === "TMPDIR"
      ) {
        return true;
      }
      return key.startsWith("XDG_") || key.startsWith("OPENCLAW_");
    })
    .toSorted(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([
    params.shell,
    params.timeoutMs,
    params.purpose,
    resolveExecCacheId(params.exec),
    startupEnvEntries,
  ]);
}

type LoginShellEnvProbeResult =
  | { ok: true; shellEnv: Map<string, string> }
  | { ok: false; error: string };

function probeLoginShellEnv(params: {
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  exec?: typeof execFileSync;
  platform?: NodeJS.Platform;
  purpose: LoginShellEnvProbePurpose;
}): LoginShellEnvProbeResult {
  const platform = params.platform ?? process.platform;
  if (platform === "win32") {
    return { ok: true, shellEnv: new Map() };
  }

  const exec = params.exec ?? execFileSync;
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  const shell = resolveShell(params.env);
  const execEnv = resolveShellExecEnv(params.env);
  const cacheKey = createLoginShellEnvCacheKey({
    shell,
    timeoutMs,
    exec: params.exec,
    execEnv,
    purpose: params.purpose,
  });
  const cached = loginShellEnvProbeCache.get(cacheKey);
  if (cached) {
    // Login-shell probes can consume the full timeout; keep active configurations ahead of
    // colder entries when the shared insertion-order pruning helper enforces the bound.
    loginShellEnvProbeCache.delete(cacheKey);
    loginShellEnvProbeCache.set(cacheKey, cached);
    return { ok: true, shellEnv: new Map(cached) };
  }

  try {
    const stdout = execLoginShellEnvZero({
      shell,
      env: execEnv,
      exec,
      timeoutMs,
      purpose: params.purpose,
    });
    const shellEnv = parseShellEnv(stdout);
    // Failed startup can recover on the next lookup; retain only successful probes.
    loginShellEnvProbeCache.set(cacheKey, [...shellEnv.entries()]);
    pruneMapToMaxSize(loginShellEnvProbeCache, LOGIN_SHELL_ENV_CACHE_LIMIT);
    return { ok: true, shellEnv };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

type ShellEnvFallbackResult =
  | { ok: true; applied: string[]; skippedReason?: never }
  | { ok: true; applied: []; skippedReason: "already-has-keys" | "disabled" }
  | { ok: false; error: string; applied: [] };

type ShellEnvFallbackOptions = {
  enabled: boolean;
  env: NodeJS.ProcessEnv;
  expectedKeys: string[];
  logger?: Pick<typeof console, "warn">;
  timeoutMs?: number;
  exec?: typeof execFileSync;
  platform?: NodeJS.Platform;
};

function hasExplicitEnvBinding(env: NodeJS.ProcessEnv, key: string): boolean {
  return Object.hasOwn(env, key);
}

export function loadShellEnvFallback(opts: ShellEnvFallbackOptions): ShellEnvFallbackResult {
  const logger = opts.logger ?? console;

  if (!opts.enabled) {
    lastAppliedKeys = [];
    return { ok: true, applied: [], skippedReason: "disabled" };
  }

  const missingExpectedKeys = opts.expectedKeys.filter(
    (key) => !hasExplicitEnvBinding(opts.env, key),
  );
  if (missingExpectedKeys.length === 0) {
    lastAppliedKeys = [];
    return { ok: true, applied: [], skippedReason: "already-has-keys" };
  }

  const probe = probeLoginShellEnv({
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    exec: opts.exec,
    platform: opts.platform,
    purpose: "environment-import",
  });
  if (!probe.ok) {
    logger.warn(`[openclaw] shell env fallback failed: ${probe.error}`);
    lastAppliedKeys = [];
    return { ok: false, error: probe.error, applied: [] };
  }

  const applied: string[] = [];
  for (const key of missingExpectedKeys) {
    const value = probe.shellEnv.get(key);
    if (!value?.trim()) {
      continue;
    }
    opts.env[key] = value;
    applied.push(key);
  }

  lastAppliedKeys = applied;
  return { ok: true, applied };
}

export function shouldEnableShellEnvFallback(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvValue(env.OPENCLAW_LOAD_SHELL_ENV);
}

export function shouldDeferShellEnvFallback(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvValue(env.OPENCLAW_DEFER_SHELL_ENV_FALLBACK);
}

export function resolveShellEnvFallbackTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OPENCLAW_SHELL_ENV_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = parseStrictNonNegativeInteger(raw);
  if (parsed === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  return resolveTimeoutMs(parsed);
}

export function getShellPathFromLoginShell(opts: {
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  exec?: typeof execFileSync;
  platform?: NodeJS.Platform;
}): string | null {
  if (cachedShellPath !== undefined) {
    return cachedShellPath;
  }
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    cachedShellPath = null;
    return cachedShellPath;
  }

  const probe = probeLoginShellEnv({
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    exec: opts.exec,
    platform,
    purpose: "path",
  });
  if (!probe.ok) {
    return null;
  }

  const shellPath = probe.shellEnv.get("PATH")?.trim();
  cachedShellPath = shellPath && shellPath.length > 0 ? shellPath : null;
  return cachedShellPath;
}

type UserShellExecutableResolution = {
  executable: string;
  /** Present only when the login-shell PATH selected the executable. */
  pathEnv?: string;
};

export function resolveExecutableFromUserShellPath(
  executable: string,
  opts: {
    env: NodeJS.ProcessEnv;
    pathEnv?: string;
    includeExtensionless?: boolean;
    strategy: "fallback" | "prefer";
    timeoutMs?: number;
    exec?: typeof execFileSync;
    platform?: NodeJS.Platform;
  },
): UserShellExecutableResolution | undefined {
  const direct = resolveExecutableFromPathEnv(
    executable,
    opts.pathEnv ?? opts.env.PATH ?? opts.env.Path ?? "",
    opts.env,
    { includeExtensionless: opts.includeExtensionless },
  );
  if (direct && opts.strategy === "fallback") {
    return { executable: direct };
  }
  const shellPath = getShellPathFromLoginShell({
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    exec: opts.exec,
    platform: opts.platform,
  });
  if (!shellPath) {
    return direct ? { executable: direct } : undefined;
  }
  const resolved = resolveExecutableFromPathEnv(executable, shellPath, opts.env, {
    includeExtensionless: opts.includeExtensionless,
  });
  if (resolved) {
    return { executable: resolved, pathEnv: shellPath };
  }
  return direct ? { executable: direct } : undefined;
}

export function getShellEnvAppliedKeys(): string[] {
  return [...lastAppliedKeys];
}

export function clearShellEnvAppliedKeys(keys: readonly string[]): void {
  const removed = new Set(keys);
  lastAppliedKeys = lastAppliedKeys.filter((key) => !removed.has(key));
}
