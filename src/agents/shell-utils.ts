import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  killProcessTree as killProcessTreeGracefully,
  type KillProcessTreeOptions,
} from "../process/kill-tree.js";
import { getBinDir } from "./config.js";

export interface ShellConfig {
  shell: string;
  args: string[];
}

export function resolvePowerShellPath(): string {
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

export function getPosixShellArgs(shellPath: string): string[] {
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

export function resolveWindowsBashPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
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

export function getShellConfig(customShellPath?: string): ShellConfig {
  if (customShellPath) {
    if (!fs.existsSync(customShellPath)) {
      throw new Error(`Custom shell path not found: ${customShellPath}`);
    }
    return { shell: customShellPath, args: getPosixShellArgs(customShellPath) };
  }

  if (process.platform === "win32") {
    // Use PowerShell instead of cmd.exe on Windows.
    // Problem: Many Windows system utilities (ipconfig, systeminfo, etc.) write
    // directly to the console via WriteConsole API, bypassing stdout pipes.
    // When Node.js spawns cmd.exe with piped stdio, these utilities produce no output.
    // PowerShell properly captures and redirects their output to stdout.
    return {
      shell: resolvePowerShellPath(),
      args: ["-NoProfile", "-NonInteractive", "-Command"],
    };
  }

  const rawEnvShell = process.env.SHELL?.trim();
  const envShell = rawEnvShell && !isNonInteractiveShell(rawEnvShell) ? rawEnvShell : undefined;
  const shellName = envShell ? path.basename(envShell) : "";
  // Fish rejects common bashisms used by tools, so prefer bash when detected.
  if (shellName === "fish") {
    const bash = resolveShellFromPath("bash");
    if (bash) {
      return { shell: bash, args: getPosixShellArgs(bash) };
    }
    const sh = resolveShellFromPath("sh");
    if (sh) {
      return { shell: sh, args: getPosixShellArgs(sh) };
    }
  }
  if (envShell) {
    return { shell: envShell, args: getPosixShellArgs(envShell) };
  }
  // Placeholder SHELL (or unset): prefer a resolved sh/bash on PATH so we do not
  // re-invoke the placeholder and get a spurious exitCode=1.
  const shell = resolveShellFromPath("sh") ?? resolveShellFromPath("bash") ?? "sh";
  return { shell, args: getPosixShellArgs(shell) };
}

export function getBashShellConfig(customShellPath?: string): ShellConfig {
  if (customShellPath) {
    if (!fs.existsSync(customShellPath)) {
      throw new Error(`Custom shell path not found: ${customShellPath}`);
    }
    return { shell: customShellPath, args: getPosixShellArgs(customShellPath) };
  }

  if (process.platform === "win32") {
    const bash = resolveWindowsBashPath();
    if (bash) {
      return { shell: bash, args: ["-c"] };
    }
    throw new Error("No bash shell found. Install Git for Windows or add bash.exe to PATH.");
  }

  if (fs.existsSync("/bin/bash")) {
    return { shell: "/bin/bash", args: getPosixShellArgs("/bin/bash") };
  }

  const shell =
    resolveShellFromPath("bash") ??
    resolveShellFromWhich("bash") ??
    resolveShellFromPath("sh") ??
    "sh";
  return { shell, args: getPosixShellArgs(shell) };
}

export function resolveShellFromPath(
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

export function resolveShellFromWhich(name: string): string | undefined {
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

export function sanitizeBinaryOutput(text: string): string {
  const scrubbed = text.replace(/[\p{Format}\p{Surrogate}]/gu, "");
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
    if (code < 0x20) {
      continue;
    }
    chunks.push(char);
  }
  return chunks.join("");
}

export function getShellEnv(): NodeJS.ProcessEnv {
  const binDir = getBinDir();
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = process.env[pathKey] ?? "";
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
  const updatedPath = pathEntries.includes(binDir)
    ? currentPath
    : [binDir, currentPath].filter(Boolean).join(path.delimiter);

  return {
    ...process.env,
    [pathKey]: updatedPath,
  };
}

export function killProcessTree(pid: number, opts?: KillProcessTreeOptions): void {
  killProcessTreeGracefully(pid, { force: true, ...opts });
}
