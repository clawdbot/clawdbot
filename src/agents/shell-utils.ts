import fs from "node:fs";
import path from "node:path";

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

export function getShellConfig(): { shell: string; args: string[] } {
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

export function resolveShellFromPath(name: string): string | undefined {
  const envPath = process.env.PATH ?? "";
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
