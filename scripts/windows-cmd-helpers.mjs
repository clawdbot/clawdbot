// Windows cmd.exe quoting helpers for npm/pnpm command shims.
const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>%\r\n]/;

/**
 * Resolves the correctly cased PATH key in a Windows-style env object.
 */
export function resolvePathEnvKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
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
