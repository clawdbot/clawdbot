// Windows command-line construction and cmd.exe quoting for the MXC
// ProcessContainer backend.
//
// Security note: `command` and `args` originate from the agent/tool layer and
// are embedded into MXC's `process.commandLine`, which MXC passes to
// CreateProcessInSandbox -> cmd.exe *inside* the AppContainer sandbox. They
// never reach a host shell and cannot influence the base64 sandbox-policy
// payload (that travels on a separate argv flag to wxc-exec). Quoting here is
// about delivering arguments to the sandboxed program intact and preventing
// `%`-expansion / quote-breakout within the inner cmd.exe command line.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

function resolveCmdShell(): string {
  return process.env.ComSpec?.trim() || "cmd.exe";
}

// `cmd.exe /d /s /c "<line>"`: `/d` skips AutoRun, `/s` makes cmd.exe strip
// exactly one outer quote pair without re-parsing the inner line, which lets the
// wrapped script keep embedded `"` chars.
export function buildCommandLine(commandScript: string, args: readonly string[]): string {
  const shell = resolveCmdShell();
  if (args.length === 0) {
    return `${shell} /d /s /c "${commandScript}"`;
  }
  const escapedArgs = args.map(cmdArgumentEscape).join(" ");
  return `${shell} /d /s /c "${cmdArgumentEscape(commandScript)} ${escapedArgs}"`;
}

// Quote a single cmd.exe token: wrap in double quotes and neutralize the chars
// that would otherwise break out of the quoted token or trigger expansion:
// `"` -> `""` (cmd's in-quote quote escape), `%` -> `%%` (suppress env
// expansion), `^` -> `^^` (caret escape) so the token survives cmd parsing.
function cmdArgumentEscape(value: string): string {
  return `"${value.replaceAll("^", "^^").replaceAll("%", "%%").replaceAll(`"`, `""`)}"`;
}

// When positional args accompany a script, cmd.exe cannot reliably receive both
// an inline script and argv. Materialize the script as a temporary `.cmd` file
// (exclusive-create, owner-only mode) and run that file with the args appended.
// The caller must invoke `cleanup()` once the command has been built.
export function createWindowsCommandBridge(params: {
  args: readonly string[] | undefined;
  script: string;
  tempDir: string;
}): { command: string; cleanup: () => void } {
  if (!params.args || params.args.length === 0) {
    return { command: params.script, cleanup: () => {} };
  }

  const bridgeDir = mkdtempSync(path.join(params.tempDir, ".openclaw-mxc-cmd-"));
  const commandFile = path.join(bridgeDir, `${randomBytes(8).toString("hex")}.cmd`);
  try {
    writeFileSync(commandFile, `@echo off\r\n${params.script}`, { flag: "wx", mode: 0o600 });
  } catch (err) {
    rmSync(bridgeDir, { force: true, recursive: true });
    throw err;
  }
  return {
    command: commandFile,
    cleanup: () => rmSync(bridgeDir, { force: true, recursive: true }),
  };
}
