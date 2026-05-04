import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isTruthyEnvValue } from "./env.js";
import { formatErrorMessage } from "./errors.js";
import { sanitizeHostExecEnv } from "./host-env-security.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_SHELL = "/bin/sh";
let lastAppliedKeys: string[] = [];
let cachedShellPath: string | null | undefined;
let cachedEtcShells: Set<string> | null | undefined;
let nextExecCacheId = 1;
const loginShellEnvProbeCache = new Map<
  string,
  { ok: true; entries: Array<[string, string]> } | { ok: false; error: string }
>();
const execCacheIds = new WeakMap<object, number>();

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
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(0, timeoutMs);
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
}): Buffer {
  return params.exec(params.shell, ["-l", "-c", "env -0"], {
    encoding: "buffer",
    timeout: params.timeoutMs,
    maxBuffer: DEFAULT_MAX_BUFFER_BYTES,
    env: params.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseShellEnv(stdout: Buffer): Map<string, string> {
  const shellEnv = new Map<string, string>();
  const parts = stdout.toString("utf8").split("\0");
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
}): LoginShellEnvProbeResult {
  const exec = params.exec ?? execFileSync;
  const timeoutMs = resolveTimeoutMs(params.timeoutMs);
  const shell = resolveShell(params.env);
  const execEnv = resolveShellExecEnv(params.env);
  const cacheKey = createLoginShellEnvCacheKey({
    shell,
    timeoutMs,
    exec: params.exec,
    execEnv,
  });
  const cached = loginShellEnvProbeCache.get(cacheKey);
  if (cached) {
    return cached.ok ? { ok: true, shellEnv: new Map(cached.entries) } : cached;
  }

  try {
    const stdout = execLoginShellEnvZero({ shell, env: execEnv, exec, timeoutMs });
    const shellEnv = parseShellEnv(stdout);
    loginShellEnvProbeCache.set(cacheKey, { ok: true, entries: [...shellEnv.entries()] });
    return { ok: true, shellEnv };
  } catch (err) {
    const result = { ok: false as const, error: formatErrorMessage(err) };
    loginShellEnvProbeCache.set(cacheKey, result);
    return result;
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
};

function hasExplicitEnvBinding(env: NodeJS.ProcessEnv, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key);
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
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(0, parsed);
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
  });
  if (!probe.ok) {
    cachedShellPath = null;
    return cachedShellPath;
  }

  const shellPath = probe.shellEnv.get("PATH")?.trim();
  cachedShellPath = shellPath && shellPath.length > 0 ? shellPath : null;
  return cachedShellPath;
}

export function resetShellPathCacheForTests(): void {
  cachedShellPath = undefined;
  cachedEtcShells = undefined;
  loginShellEnvProbeCache.clear();
  nextExecCacheId = 1;
}

export function getShellEnvAppliedKeys(): string[] {
  return [...lastAppliedKeys];
}
