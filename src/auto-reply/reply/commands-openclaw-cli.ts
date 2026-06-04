// Formats OpenClaw CLI command snippets for chat-facing command responses.
function quoteShellArg(value: string): string {
  if (process.platform === "win32") {
    return `'${value.replaceAll("'", "''")}'`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Reconstructs the current OpenClaw CLI invocation with extra args. */
export function buildCurrentOpenClawCliArgv(args: string[]): string[] {
  const entry = process.argv[1]?.trim();
  return entry && entry !== process.execPath
    ? [process.execPath, ...process.execArgv, entry, ...args]
    : [process.execPath, ...args];
}

/** Builds a shell-quoted command string for rerunning the current OpenClaw CLI. */
export function buildCurrentOpenClawCliCommand(args: string[]): string {
  return buildCurrentOpenClawCliArgv(args).map(quoteShellArg).join(" ");
}
