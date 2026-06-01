import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { killProcessTree } from "../process/kill-tree.js";

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_REFRESH_MS = 5 * 60 * 1000;
const SNAPSHOT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const CAPTURE_MARKER = "__OPENCLAW_SHELL_SNAPSHOT_CAPTURE__";
const ENV_MARKER = "__OPENCLAW_SHELL_SNAPSHOT_ENV__";
const EXEC_SHELL_SNAPSHOT_ENV = "OPENCLAW_EXEC_SHELL_SNAPSHOT";
const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SNAPSHOT_SHELLS = new Set(["bash", "zsh"]);
const SNAPSHOT_DISABLE_VALUES = new Set(["0", "false", "no", "off"]);
const SAFE_ENV_NAMES = new Set([
  "ASDF_DIR",
  "BUN_INSTALL",
  "CARGO_HOME",
  "CDPATH",
  "GOPATH",
  "GOROOT",
  "GOENV_ROOT",
  "HOMEBREW_CELLAR",
  "HOMEBREW_PREFIX",
  "HOMEBREW_REPOSITORY",
  "INFOPATH",
  "MANPATH",
  "NVM_DIR",
  "PATH",
  "PNPM_HOME",
  "PYENV_ROOT",
  "RBENV_ROOT",
  "RUSTUP_HOME",
  "VOLTA_HOME",
]);
const CAPTURE_ENV_NAMES = new Set([
  ...SAFE_ENV_NAMES,
  "HOME",
  "OPENCLAW_SHELL",
  "SHELL",
  "USERPROFILE",
  "ZDOTDIR",
]);
const SECRET_ENV_PATTERN = /(secret|token|password|passwd|credential|cookie|session|auth|key)/i;
const SECRET_SHELL_STATE_PATTERNS = [
  /\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|credential)\b\s*[:=]/i,
  /\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API_KEY|ACCESS_KEY|SESSION)[A-Z0-9_]*\s*[:=]/,
  /\b(GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY)\b/,
  /\b(ghp_|github_pat_|sk-[A-Za-z0-9]|xox[baprs]-|ya29\.|AIza[0-9A-Za-z_-]|AKIA[0-9A-Z]{16})/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
] as const;

type ShellSnapshot = {
  path: string;
};

export type ShellSnapshotWrapOptions = {
  command: string;
  shell: string;
  shellArgs: string[];
  cwd: string;
  env: Record<string, string | undefined>;
};

const snapshotCache = new Map<
  string,
  { createdAtMs: number; promise: Promise<ShellSnapshot | null> }
>();
let cleanupPromise: Promise<void> | null = null;

export async function maybeWrapCommandWithShellSnapshot(
  opts: ShellSnapshotWrapOptions,
): Promise<string> {
  if (
    process.platform === "win32" ||
    isExecShellSnapshotDisabled(process.env) ||
    !isSupportedSnapshotShell(opts.shell, opts.shellArgs)
  ) {
    return opts.command;
  }

  try {
    const snapshot = await getOrCreateShellSnapshot(opts);
    return snapshot
      ? buildSnapshotWrappedCommand(
          opts.command,
          snapshot.path,
          buildRuntimeEnvRestoreScript(opts.env),
        )
      : opts.command;
  } catch {
    return opts.command;
  }
}

export function resetShellSnapshotCacheForTests(): void {
  snapshotCache.clear();
  cleanupPromise = null;
}

export function resolveShellSnapshotDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.join(resolveStateDir(env as NodeJS.ProcessEnv), "cache", "shell-snapshots");
}

function isSupportedSnapshotShell(shell: string, shellArgs: string[]): boolean {
  return shellArgs.includes("-c") && SNAPSHOT_SHELLS.has(path.basename(shell));
}

function isExecShellSnapshotDisabled(env: Record<string, string | undefined>): boolean {
  const value = env[EXEC_SHELL_SNAPSHOT_ENV]?.trim().toLowerCase();
  return Boolean(value && SNAPSHOT_DISABLE_VALUES.has(value));
}

async function getOrCreateShellSnapshot(
  opts: ShellSnapshotWrapOptions,
): Promise<ShellSnapshot | null> {
  const key = buildSnapshotKey(opts);
  const cached = snapshotCache.get(key);
  const now = Date.now();
  if (cached && now - cached.createdAtMs < SNAPSHOT_REFRESH_MS) {
    return await cached.promise;
  }
  const created = createShellSnapshot(opts, key, { forceRefresh: Boolean(cached) });
  snapshotCache.set(key, { createdAtMs: now, promise: created });
  return await created;
}

function buildSnapshotKey(opts: ShellSnapshotWrapOptions): string {
  // Snapshot capture executes shell startup files before the approved command.
  // Use process-owned roots/env only; per-call exec.env is model-controlled.
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: SNAPSHOT_VERSION,
        shell: opts.shell,
        shellArgs: opts.shellArgs,
        cwd: path.resolve(opts.cwd),
        home: getTrustedShellHome(),
        stateDir: resolveStateDir(process.env),
        env: buildSafeEnvSignature(process.env),
        startup: buildStartupSignature(opts.shell),
      }),
    )
    .digest("hex");
}

function buildSafeEnvSignature(
  env: Record<string, string | undefined>,
): Array<[string, string | null]> {
  return [...SAFE_ENV_NAMES]
    .toSorted()
    .map((key): [string, string | null] => [key, env[key] ?? null]);
}

function buildStartupSignature(shell: string): Array<[string, number, number] | [string, null]> {
  const shellName = path.basename(shell);
  const home = getTrustedShellHome();
  const zdotdir = process.env.ZDOTDIR?.trim() || home;
  const candidates =
    shellName === "zsh"
      ? [path.join(zdotdir, ".zshrc")]
      : shellName === "bash"
        ? [path.join(home, ".bashrc")]
        : [];
  return candidates.map((candidate) => {
    try {
      const stat = statSync(candidate);
      return [candidate, stat.mtimeMs, stat.size];
    } catch {
      return [candidate, null];
    }
  });
}

function getTrustedShellHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

async function createShellSnapshot(
  opts: ShellSnapshotWrapOptions,
  key: string,
  options?: { forceRefresh?: boolean },
): Promise<ShellSnapshot | null> {
  const snapshotDir = resolveShellSnapshotDir(process.env);
  await fs.mkdir(snapshotDir, { recursive: true, mode: 0o700 });
  cleanupPromise ??= cleanupStaleSnapshots(snapshotDir);
  void cleanupPromise;

  const snapshotPath = path.join(snapshotDir, `${key}.sh`);
  if (
    options?.forceRefresh !== true &&
    (await isFreshSnapshot(snapshotPath)) &&
    (await validateSnapshot(opts, snapshotPath))
  ) {
    return { path: snapshotPath };
  }

  const capture = await captureShellSnapshot(opts);
  if (!capture) {
    return null;
  }

  const tmpPath = path.join(snapshotDir, `${key}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmpPath, capture, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(tmpPath, 0o600);
  if (!(await validateSnapshot(opts, tmpPath))) {
    await fs.rm(tmpPath, { force: true });
    return null;
  }
  await fs.rename(tmpPath, snapshotPath);
  await fs.chmod(snapshotPath, 0o600);
  return { path: snapshotPath };
}

async function isFreshSnapshot(snapshotPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(snapshotPath);
    return Date.now() - stat.mtimeMs < SNAPSHOT_REFRESH_MS;
  } catch {
    return false;
  }
}

async function validateSnapshot(
  opts: ShellSnapshotWrapOptions,
  snapshotPath: string,
): Promise<boolean> {
  try {
    await fs.access(snapshotPath);
  } catch {
    return false;
  }
  const result = await runShell({
    shell: opts.shell,
    shellArgs: opts.shellArgs,
    cwd: opts.cwd,
    env: buildTrustedSnapshotCaptureEnv(opts.env),
    command: `. ${shQuote(snapshotPath)} >/dev/null 2>&1; :`,
    timeoutMs: 2_000,
  });
  return result.status === 0;
}

async function captureShellSnapshot(opts: ShellSnapshotWrapOptions): Promise<string | null> {
  const shellName = path.basename(opts.shell);
  const captureOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-shell-snapshot-"));
  await fs.chmod(captureOutputDir, 0o700);
  const captureOutputPath = path.join(captureOutputDir, "snapshot.out");
  const captureOutputFile = await fs.open(captureOutputPath, "wx", 0o600);
  await captureOutputFile.close();
  const captureCommand = [
    "{",
    buildStartupSourceScript(shellName),
    `printf '\\n%s\\n' ${shQuote(CAPTURE_MARKER)}`,
    buildAliasCaptureScript(shellName),
    "(typeset -f 2>/dev/null || declare -f 2>/dev/null || true)",
    `printf '\\n%s\\n' ${shQuote(ENV_MARKER)}`,
    `${shQuote(process.execPath)} -e ${shQuote(ENV_CAPTURE_NODE_SCRIPT)}`,
    `} > ${shQuote(captureOutputPath)}`,
  ].join("\n");

  try {
    const result = await runShell({
      shell: opts.shell,
      shellArgs: buildCaptureShellArgs(shellName, opts.shellArgs),
      cwd: opts.cwd,
      env: buildTrustedSnapshotCaptureEnv(opts.env),
      command: captureCommand,
      timeoutMs: 5_000,
    });
    if (result.status !== 0) {
      return null;
    }
    const stdout = await fs.readFile(captureOutputPath, "utf8");
    return buildSnapshotFile(stdout);
  } finally {
    await fs.rm(captureOutputDir, { force: true, recursive: true });
  }
}

function buildCaptureShellArgs(shellName: string, shellArgs: string[]): string[] {
  if (shellName === "bash") {
    return ["-i", "-c"];
  }
  if (shellName === "zsh") {
    return ["-f", "-i", "-c"];
  }
  return shellArgs;
}

function buildSnapshotCaptureEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => CAPTURE_ENV_NAMES.has(key) && !SECRET_ENV_PATTERN.test(key),
    ),
  );
}

function buildTrustedSnapshotCaptureEnv(
  runtimeEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env = buildSnapshotCaptureEnv(process.env);
  // OPENCLAW_SHELL is injected by the exec runtime, so startup files can keep
  // their documented exec-specific branches without trusting model input.
  if (runtimeEnv.OPENCLAW_SHELL === "exec") {
    env.OPENCLAW_SHELL = "exec";
  }
  return env;
}

function buildStartupSourceScript(shellName: string): string {
  if (shellName === "zsh") {
    return `if [ -r "\${ZDOTDIR:-$HOME}/.zshrc" ]; then . "\${ZDOTDIR:-$HOME}/.zshrc"; fi`;
  }
  if (shellName === "bash") {
    return ":";
  }
  return ":";
}

function buildAliasCaptureScript(shellName: string): string {
  return shellName === "zsh" ? "alias -L 2>/dev/null || true" : "alias 2>/dev/null || true";
}

const ENV_CAPTURE_NODE_SCRIPT = `
const safe = new Set(${JSON.stringify([...SAFE_ENV_NAMES].toSorted())});
const blocked = ${SECRET_ENV_PATTERN.toString()};
const out = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!safe.has(key) || blocked.test(key)) continue;
  out[key] = value;
}
process.stdout.write(JSON.stringify(out));
`.trim();

function buildSnapshotFile(stdout: string): string | null {
  const captureIndex = stdout.indexOf(CAPTURE_MARKER);
  const envIndex = stdout.indexOf(ENV_MARKER);
  if (captureIndex === -1 || envIndex === -1 || envIndex <= captureIndex) {
    return null;
  }

  const shellState = stdout
    .slice(captureIndex + CAPTURE_MARKER.length, envIndex)
    .trim()
    .split(/\r?\n/)
    .filter((line) => !line.includes(CAPTURE_MARKER) && !line.includes(ENV_MARKER))
    .join("\n");
  if (containsSecretLikeShellState(shellState)) {
    return null;
  }
  const exports = parseSafeEnvExports(stdout.slice(envIndex + ENV_MARKER.length).trim());

  return [
    "# OpenClaw exec shell snapshot. Generated; do not edit.",
    'if [ -n "${BASH_VERSION:-}" ]; then shopt -s expand_aliases 2>/dev/null || true; fi',
    "unalias -a 2>/dev/null || true",
    shellState,
    exports,
    "",
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function containsSecretLikeShellState(shellState: string): boolean {
  return SECRET_SHELL_STATE_PATTERNS.some((pattern) => pattern.test(shellState));
}

function parseSafeEnvExports(envJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(envJson);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "";
  }
  return Object.entries(parsed)
    .filter(
      (entry): entry is [string, string] =>
        VALID_ENV_NAME.test(entry[0]) &&
        SAFE_ENV_NAMES.has(entry[0]) &&
        !SECRET_ENV_PATTERN.test(entry[0]) &&
        typeof entry[1] === "string",
    )
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `export ${key}=${shQuote(value)}`)
    .join("\n");
}

function buildRuntimeEnvRestoreScript(env: Record<string, string | undefined>): string {
  return [...SAFE_ENV_NAMES]
    .toSorted()
    .filter((key) => env[key] !== process.env[key] && !SECRET_ENV_PATTERN.test(key))
    .map((key) =>
      typeof env[key] === "string" ? `export ${key}=${shQuote(env[key])}` : `unset ${key}`,
    )
    .join("\n");
}

function buildSnapshotWrappedCommand(
  command: string,
  snapshotPath: string,
  runtimeEnvRestoreScript: string,
): string {
  return [
    `if [ -r ${shQuote(snapshotPath)} ]; then . ${shQuote(snapshotPath)}; fi`,
    runtimeEnvRestoreScript,
    // Alias expansion happens while shells parse a command. Re-parse the user command
    // after sourcing the snapshot so zsh/bash aliases captured from startup files work.
    `eval ${shQuote(command)}`,
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runShell(opts: {
  shell: string;
  shellArgs: string[];
  command: string;
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}): Promise<{ status: number | null; stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn(opts.shell, [...opts.shellArgs, opts.command], {
      cwd: opts.cwd,
      detached: process.platform !== "win32",
      env: opts.env,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    const finish = (status: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      killProcessTree(child.pid ?? 0, { graceMs: 0 });
      child.stdout.destroy();
      resolve({ status, stdout });
    };
    const timeout = setTimeout(() => {
      killProcessTree(child.pid ?? 0, { graceMs: 250 });
      finish(null);
    }, opts.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => {
      finish(null);
    });
    // Resolve on shell exit rather than pipe close. Startup files can leave
    // background descendants holding stdout, and capture must stay bounded.
    child.on("exit", (status) => {
      setTimeout(() => finish(status), 250);
    });
    child.on("close", (status) => {
      finish(status);
    });
  });
}

async function cleanupStaleSnapshots(snapshotDir: string): Promise<void> {
  const cutoff = Date.now() - SNAPSHOT_MAX_AGE_MS;
  let entries: string[];
  try {
    entries = await fs.readdir(snapshotDir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".sh") || entry.endsWith(".tmp"))
      .map(async (entry) => {
        const target = path.join(snapshotDir, entry);
        try {
          const stat = await fs.stat(target);
          if (stat.mtimeMs < cutoff) {
            await fs.rm(target, { force: true });
          }
        } catch {
          // Best-effort cache cleanup.
        }
      }),
  );
}
