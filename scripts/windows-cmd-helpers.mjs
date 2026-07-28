// Windows cmd.exe quoting helpers for npm/pnpm command shims.
import path from "node:path";

const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>%\r\n]/;
const DEFAULT_WINDOWS_SYSTEM_ROOT = "C:\\Windows";

function getEnvValueCaseInsensitive(env, expectedKey) {
  const direct = env[expectedKey];
  if (direct !== undefined) {
    return direct;
  }
  const expected = expectedKey.toUpperCase();
  const actualKey = Object.keys(env).find((key) => key.toUpperCase() === expected);
  return actualKey ? env[actualKey] : undefined;
}

function normalizeWindowsSystemRoot(raw) {
  const trimmed = raw?.trim();
  if (
    !trimmed ||
    trimmed.includes("\0") ||
    trimmed.includes("\r") ||
    trimmed.includes("\n") ||
    trimmed.includes(";")
  ) {
    return null;
  }
  const normalized = path.win32.normalize(trimmed);
  if (!path.win32.isAbsolute(normalized) || normalized.startsWith("\\\\")) {
    return null;
  }
  const parsed = path.win32.parse(normalized);
  if (!/^[A-Za-z]:\\$/.test(parsed.root) || normalized.length <= parsed.root.length) {
    return null;
  }
  return normalized.replace(/[\\/]+$/, "");
}

/**
 * Resolves the correctly cased PATH key in a Windows-style env object.
 */
export function resolvePathEnvKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function resolveWindowsSystemRoot(env = process.env) {
  return (
    normalizeWindowsSystemRoot(getEnvValueCaseInsensitive(env, "SystemRoot")) ??
    normalizeWindowsSystemRoot(getEnvValueCaseInsensitive(env, "WINDIR")) ??
    DEFAULT_WINDOWS_SYSTEM_ROOT
  );
}

/** @internal Shared repository-script contract. */
export function resolveWindowsSystem32Path(executableName, env = process.env) {
  if (
    path.win32.basename(executableName) !== executableName ||
    !/^[A-Za-z0-9_.-]+\.exe$/u.test(executableName)
  ) {
    throw new Error(`Invalid Windows System32 executable name: ${executableName}`);
  }
  return path.win32.join(resolveWindowsSystemRoot(env), "System32", executableName);
}

export function resolveWindowsCmdExePath(env = process.env) {
  return resolveWindowsSystem32Path("cmd.exe", env);
}

/** @internal Shared repository-script contract. */
export function resolveWindowsPowerShellPath(env = process.env) {
  return path.win32.join(
    resolveWindowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function escapeForCmdExe(arg) {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(`unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}`);
  }
  const escaped = arg.replace(/\^/g, "^^");
  if (!escaped.includes(" ") && !escaped.includes('"')) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, '""')}"`;
}

/**
 * Builds a cmd.exe-safe command line or rejects unsafe shell metacharacters.
 */
export function buildCmdExeCommandLine(command, args) {
  const escapedCommand = escapeForCmdExe(command);
  const commandLine = [escapedCommand, ...args.map(escapeForCmdExe)].join(" ");
  return escapedCommand.startsWith('"') ? `"${commandLine}"` : commandLine;
}
