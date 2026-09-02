import type { InstallationTarget } from "../infra/installation-target-context.js";
import { formatCliCommand } from "./command-format.js";
import { quoteCliArg } from "./quote-cli-arg.js";

/** Bind diagnostic handoffs to their installation in POSIX shells or Windows PowerShell. */
export function formatInstallationTargetCommand(
  argv: readonly string[],
  target: InstallationTarget,
  options: { stdinPath?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const windows = process.platform === "win32";
  // PowerShell recognizes typographic single quotes as delimiters too.
  const quote = (value: string) =>
    `'${windows ? value.replace(/['\u2018-\u201b]/gu, "$&$&") : value.replaceAll("'", "'\\''")}'`;
  const command = formatCliCommand(
    argv
      .map((value) =>
        windows ? (/^[a-z0-9_-]+$/iu.test(value) ? value : quote(value)) : quoteCliArg(value),
      )
      .join(" "),
    options.env,
  );
  const selectors = [
    ["OPENCLAW_STATE_DIR", target.stateDir],
    ["OPENCLAW_CONFIG_PATH", target.configPath],
    ["OPENCLAW_WORKSPACE_DIR", target.defaultWorkspaceDir],
  ] as const;
  if (!windows) {
    const prefix = selectors.map(([key, value]) => `${key}=${quote(value)}`).join(" ");
    return `env ${prefix} ${command}${options.stdinPath ? ` < ${quote(options.stdinPath)}` : ""}`;
  }
  const saved = selectors.map(([key]) => `$env:${key}`).join(", ");
  const set = selectors.map(([key, value]) => `$env:${key}=${quote(value)};`).join(" ");
  const restore = selectors
    .map(([key], index) => `$env:${key}=$previousTarget[${index}];`)
    .join(" ");
  // Scriptblock variables are local; environment changes need explicit restoration.
  // UTF-8 stdin avoids PowerShell 5.1's ASCII default and native argv quote loss.
  const invoke = options.stdinPath
    ? `$prompt=Get-Content -Raw -Encoding UTF8 -LiteralPath ${quote(options.stdinPath)} -ErrorAction Stop; $OutputEncoding=[System.Text.UTF8Encoding]::new(); $prompt | & ${command}`
    : `& ${command}`;
  return `& { $previousTarget=@(${saved}); try { ${set} ${invoke} } finally { ${restore} } }`;
}
