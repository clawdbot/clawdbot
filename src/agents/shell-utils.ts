/**
 * Shell execution helpers.
 *
 * Resolves platform shell commands, sanitizes binary output, and exposes process-tree cleanup.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { stripAnsiForStreamChunk } from "../../packages/terminal-core/src/ansi.js";
import {
  killProcessTree as killProcessTreeGracefully,
  type KillProcessTreeOptions,
} from "../process/kill-tree.js";
import { getBinDir } from "./config.js";

type ShellConfig = {
  shell: string;
  args: string[];
} & ({ commandTransport: "argv" } | { commandTransport: "stdin" });

type ShellCommandInvocation =
  | { argv: [string, ...string[]]; input?: undefined; stdin: "ignore" }
  | { argv: [string, ...string[]]; input: string; stdin: "pipe" };

function createArgvShellConfig(shell: string, args: string[]): ShellConfig {
  return { shell, args, commandTransport: "argv" };
}

function resolvePowerShellPath(): string {
  // Prefer PowerShell 7 when available; PS 5.1 lacks "&&" support.
  const programFiles = process.env.ProgramFiles || process.env.PROGRAMFILES || "C:\\Program Files";
  const pwsh7 = path.join(programFiles, "PowerShell", "7", "pwsh.exe");
  if (fs.existsSync(pwsh7)) {
    return pwsh7;
  }

  const programW6432 = process.env.ProgramW6432;
  if (programW6432 && programW6432 !== programFiles) {
    const pwsh7Alt = path.join(programW6432, "PowerShell", "7", "pwsh.exe");
    if (fs.existsSync(pwsh7Alt)) {
      return pwsh7Alt;
    }
  }

  const pwshInPath = resolveShellFromPath("pwsh");
  if (pwshInPath) {
    return pwshInPath;
  }

  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (systemRoot) {
    const candidate = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "powershell.exe";
}

// Non-interactive placeholder shells that reject "-c"-style invocations.
// macOS LaunchDaemon service users commonly use /usr/bin/false so login sessions
// cannot be opened; honoring SHELL in that case causes every exec to exit 1.
// See https://github.com/openclaw/openclaw/issues/69077.
const NON_INTERACTIVE_SHELLS = new Set(["false", "nologin"]);

function isNonInteractiveShell(shellPath: string): boolean {
  if (!shellPath) {
    return false;
  }
  return NON_INTERACTIVE_SHELLS.has(path.basename(shellPath));
}

function getPosixShellArgs(shellPath: string): string[] {
  switch (path.basename(shellPath)) {
    case "bash":
      return ["--noprofile", "--norc", "-c"];
    case "zsh":
      return ["-f", "-c"];
    case "fish":
      return ["--no-config", "-c"];
    default:
      return ["-c"];
  }
}

function resolveWindowsBashPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = [env.ProgramFiles, env["ProgramFiles(x86)"]]
    .filter((dir): dir is string => Boolean(dir?.trim()))
    .map((dir) => path.join(dir, "Git", "bin", "bash.exe"));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return resolveShellFromPath("bash.exe", env) ?? resolveShellFromPath("bash", env);
}

const WINDOWS_GIT_BASH_CACHE_LIMIT = 16;
const windowsGitBashUsrBinCache = new Map<string, string | undefined>();
let defaultWindowsGitBashUsrBinResolved = false;
let defaultWindowsGitBashUsrBin: string | undefined;

function resolveWindowsGitBashUsrBin(shellPath: string): string | undefined {
  const cacheKey = path.resolve(shellPath).toLowerCase();
  if (windowsGitBashUsrBinCache.has(cacheKey)) {
    return windowsGitBashUsrBinCache.get(cacheKey);
  }

  const normalized = path.normalize(shellPath);
  const shellName = path.basename(normalized).toLowerCase();
  const binDir = path.dirname(normalized);
  let gitRoot: string | undefined;
  if (
    (shellName === "bash.exe" || shellName === "bash") &&
    path.basename(binDir).toLowerCase() === "bin"
  ) {
    const parent = path.dirname(binDir);
    gitRoot = path.basename(parent).toLowerCase() === "usr" ? path.dirname(parent) : parent;
  }

  const usrBin = gitRoot ? path.join(gitRoot, "usr", "bin") : undefined;
  const resolved =
    gitRoot &&
    fs.existsSync(path.join(gitRoot, "cmd", "git.exe")) &&
    usrBin &&
    fs.existsSync(usrBin)
      ? usrBin
      : undefined;
  if (windowsGitBashUsrBinCache.size >= WINDOWS_GIT_BASH_CACHE_LIMIT) {
    const oldestKey = windowsGitBashUsrBinCache.keys().next().value;
    if (oldestKey) {
      windowsGitBashUsrBinCache.delete(oldestKey);
    }
  }
  windowsGitBashUsrBinCache.set(cacheKey, resolved);
  return resolved;
}

function getWindowsGitBashUsrBin(shellPath?: string): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }
  if (shellPath) {
    return resolveWindowsGitBashUsrBin(shellPath);
  }
  if (!defaultWindowsGitBashUsrBinResolved) {
    defaultWindowsGitBashUsrBinResolved = true;
    const resolvedShell = resolveWindowsBashPath();
    defaultWindowsGitBashUsrBin = resolvedShell
      ? resolveWindowsGitBashUsrBin(resolvedShell)
      : undefined;
  }
  return defaultWindowsGitBashUsrBin;
}

function isLegacyWslBashPath(shellPath: string): boolean {
  const normalized = shellPath.replace(/\//g, "\\").toLowerCase();
  return /(?:^|\\)windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function resolveBashCommandConfig(shell: string): ShellConfig {
  if (isLegacyWslBashPath(shell)) {
    return { shell, args: ["-s"], commandTransport: "stdin" };
  }
  return createArgvShellConfig(
    shell,
    process.platform === "win32" ? ["-c"] : getPosixShellArgs(shell),
  );
}

export function buildShellCommandInvocation(
  command: string,
  config: ShellConfig,
): ShellCommandInvocation {
  if (config.commandTransport === "stdin") {
    // The legacy WSL launcher mangles command argv, so its -s mode must read the command from stdin.
    return { argv: [config.shell, ...config.args], input: command, stdin: "pipe" };
  }
  return { argv: [config.shell, ...config.args, command], stdin: "ignore" };
}

export function getShellConfig(customShellPath?: string): ShellConfig {
  if (customShellPath) {
    if (!fs.existsSync(customShellPath)) {
      throw new Error(`Custom shell path not found: ${customShellPath}`);
    }
    return createArgvShellConfig(customShellPath, getPosixShellArgs(customShellPath));
  }

  if (process.platform === "win32") {
    // Use PowerShell instead of cmd.exe on Windows.
    // Problem: Many Windows system utilities (ipconfig, systeminfo, etc.) write
    // directly to the console via WriteConsole API, bypassing stdout pipes.
    // When Node.js spawns cmd.exe with piped stdio, these utilities produce no output.
    // PowerShell properly captures and redirects their output to stdout.
    return createArgvShellConfig(resolvePowerShellPath(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
    ]);
  }

  const rawEnvShell = process.env.SHELL?.trim();
  const envShell = rawEnvShell && !isNonInteractiveShell(rawEnvShell) ? rawEnvShell : undefined;
  const shellName = envShell ? path.basename(envShell) : "";
  // Fish rejects common bashisms used by tools, so prefer bash when detected.
  if (shellName === "fish") {
    const bash = resolveShellFromPath("bash");
    if (bash) {
      return createArgvShellConfig(bash, getPosixShellArgs(bash));
    }
    const sh = resolveShellFromPath("sh");
    if (sh) {
      return createArgvShellConfig(sh, getPosixShellArgs(sh));
    }
  }
  if (envShell) {
    return createArgvShellConfig(envShell, getPosixShellArgs(envShell));
  }
  // Placeholder SHELL (or unset): prefer a resolved sh/bash on PATH so we do not
  // re-invoke the placeholder and get a spurious exitCode=1.
  const shell = resolveShellFromPath("sh") ?? resolveShellFromPath("bash") ?? "sh";
  return createArgvShellConfig(shell, getPosixShellArgs(shell));
}

export function getBashShellConfig(customShellPath?: string): ShellConfig {
  if (customShellPath) {
    if (!fs.existsSync(customShellPath)) {
      throw new Error(`Custom shell path not found: ${customShellPath}`);
    }
    return resolveBashCommandConfig(customShellPath);
  }

  if (process.platform === "win32") {
    const bash = resolveWindowsBashPath();
    if (bash) {
      return resolveBashCommandConfig(bash);
    }
    throw new Error("No bash shell found. Install Git for Windows or add bash.exe to PATH.");
  }

  if (fs.existsSync("/bin/bash")) {
    return resolveBashCommandConfig("/bin/bash");
  }

  const shell =
    resolveShellFromPath("bash") ??
    resolveShellFromWhich("bash") ??
    resolveShellFromPath("sh") ??
    "sh";
  return resolveBashCommandConfig(shell);
}

function resolveShellFromPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const envPath = env.PATH ?? "";
  if (!envPath) {
    return undefined;
  }
  const entries = envPath.split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // ignore missing or non-executable entries
    }
  }
  return undefined;
}

function resolveShellFromWhich(name: string): string | undefined {
  if (process.platform === "win32") {
    return undefined;
  }
  try {
    const result = spawnSync("which", [name], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.status !== 0 || !result.stdout) {
      return undefined;
    }
    const firstMatch = result.stdout.trim().split(/\r?\n/)[0]?.trim();
    return firstMatch || undefined;
  } catch {
    return undefined;
  }
}

function normalizeShellName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return path
    .basename(trimmed)
    .replace(/\.(exe|cmd|bat)$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "");
}

export function detectRuntimeShell(): string | undefined {
  const overrideShell = process.env.OPENCLAW_SHELL?.trim();
  if (overrideShell) {
    const name = normalizeShellName(overrideShell);
    if (name) {
      return name;
    }
  }

  if (process.platform === "win32") {
    if (process.env.POWERSHELL_DISTRIBUTION_CHANNEL) {
      return "pwsh";
    }
    return "powershell";
  }

  const envShell = process.env.SHELL?.trim();
  if (envShell && !isNonInteractiveShell(envShell)) {
    const name = normalizeShellName(envShell);
    if (name) {
      return name;
    }
  }

  if (process.env.POWERSHELL_DISTRIBUTION_CHANNEL) {
    return "pwsh";
  }
  if (process.env.BASH_VERSION) {
    return "bash";
  }
  if (process.env.ZSH_VERSION) {
    return "zsh";
  }
  if (process.env.FISH_VERSION) {
    return "fish";
  }
  if (process.env.KSH_VERSION) {
    return "ksh";
  }
  if (process.env.NU_VERSION || process.env.NUSHELL_VERSION) {
    return "nu";
  }

  return undefined;
}

export function sanitizeBinaryOutput(
  text: string,
  options?: { ansiMode?: "standard" | "compat" },
): string {
  // Output callbacks are stream chunks, not true EOF. Preserve a pending CSI
  // visibly so a split final byte cannot leak from the following chunk.
  const scrubbed = stripAnsiForStreamChunk(text, {
    compatibilityGrammar: options?.ansiMode === "compat",
  }).replace(/[\p{Format}\p{Surrogate}]/gu, "");
  if (!scrubbed) {
    return scrubbed;
  }
  const chunks: string[] = [];
  for (const char of scrubbed) {
    const code = char.codePointAt(0);
    if (code == null) {
      continue;
    }
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      chunks.push(char);
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      chunks.push(`\\x${code.toString(16).padStart(2, "0")}`);
      continue;
    }
    chunks.push(char);
  }
  return chunks.join("");
}

function getShellEnv(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const binDir = getBinDir();
  const pathKeys = Object.keys(sourceEnv).filter((key) => key.toLowerCase() === "path");
  // Node sorts Windows environment keys and passes only the first case-insensitive match.
  // Collapse duplicates before spawning so callers and child processes see the same PATH.
  const sourcePathKey = process.platform === "win32" ? pathKeys.toSorted()[0] : pathKeys[0];
  const pathKey = process.platform === "win32" ? "PATH" : (sourcePathKey ?? "PATH");
  const currentPath = sourcePathKey ? (sourceEnv[sourcePathKey] ?? "") : "";
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
  const updatedPath = pathEntries.includes(binDir)
    ? currentPath
    : [binDir, currentPath].filter(Boolean).join(path.delimiter);
  const env = { ...sourceEnv };
  if (process.platform === "win32") {
    for (const key of pathKeys) {
      delete env[key];
    }
  }
  env[pathKey] = updatedPath;
  return env;
}

export function getBashShellEnv(
  shellPath?: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = getShellEnv(sourceEnv);
  const usrBin = getWindowsGitBashUsrBin(shellPath);
  if (!usrBin) {
    return env;
  }

  const currentPath = env.PATH ?? "";
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
  const normalizedUsrBin = usrBin.toLowerCase();
  env.PATH = [
    usrBin,
    ...pathEntries.filter((entry) => entry.toLowerCase() !== normalizedUsrBin),
  ].join(path.delimiter);
  return env;
}

export function killProcessTree(pid: number, opts?: KillProcessTreeOptions): void {
  killProcessTreeGracefully(pid, { force: true, ...opts });
}
