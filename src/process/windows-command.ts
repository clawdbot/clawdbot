// Windows command helpers resolve executable and shell invocation details.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  isRegularFile,
  resolveExecutableFromPathEnv,
  resolveExecutablePathCandidate,
} from "../infra/executable-path.js";
import { getWindowsCmdExePath } from "../infra/windows-install-roots.js";

const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>%\r\n]/;

function resolveNpmArgvForWindows(argv: string[]): string[] | null {
  if (process.platform !== "win32" || argv.length === 0) {
    return null;
  }
  const basename = normalizeLowercaseStringOrEmpty(
    path.basename(expectDefined(argv[0], "argv entry at 0")),
  ).replace(/\.(cmd|exe|bat)$/, "");
  const cliName = basename === "npx" ? "npx-cli.js" : basename === "npm" ? "npm-cli.js" : null;
  if (!cliName) {
    return null;
  }
  const cliPath = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", cliName);
  if (fs.existsSync(cliPath)) {
    return [process.execPath, cliPath, ...argv.slice(1)];
  }
  // Bun-based runs don't ship npm-cli.js next to process.execPath. The .cmd
  // fallback remains inside the trusted cmd.exe wrapper below.
  const command = argv[0] ?? "";
  const extension = normalizeLowercaseStringOrEmpty(path.extname(command));
  return [extension ? command : `${command}.cmd`, ...argv.slice(1)];
}

function createWindowsCommandNotFoundError(command: string): NodeJS.ErrnoException {
  const error = new Error(`spawn ${command} ENOENT`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  error.path = command;
  error.syscall = `spawn ${command}`;
  return error;
}

function resolveWindowsEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(env).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}

function resolveWindowsCommandFromCwdOrPath(params: {
  command: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
}): string | undefined {
  const hasPathSeparator = params.command.includes("/") || params.command.includes("\\");
  if (hasPathSeparator) {
    const candidate = resolveExecutablePathCandidate(params.command, {
      cwd: params.cwd,
      env: params.env,
    });
    if (!candidate) {
      return undefined;
    }
    // PATHEXT controls suffix probing, not whether an explicit path is executable.
    // The supported-extension check below still rejects shell/script formats.
    if (path.extname(candidate)) {
      return isRegularFile(candidate) ? candidate : undefined;
    }
    return resolveExecutableFromPathEnv(
      path.basename(candidate),
      path.dirname(candidate),
      params.env,
      { includeExtensionless: false },
    );
  }
  const cwd = params.cwd?.trim() || process.cwd();
  const pathValue =
    resolveWindowsEnvironmentValue(params.env, "PATH") ??
    resolveWindowsEnvironmentValue(process.env, "PATH") ??
    "";
  const pathEntries = pathValue
    .split(";")
    .map((entry) => entry.replace(/^"(.*)"$/, "$1").trim())
    .filter(Boolean)
    .map((entry) => (path.isAbsolute(entry) ? entry : path.resolve(cwd, entry)));
  // Bare names search PATH only. Requiring an explicit relative path prevents
  // an untrusted child cwd from shadowing installed tools such as git or node.
  return resolveExecutableFromPathEnv(params.command, pathEntries.join(";"), params.env, {
    includeExtensionless: false,
  });
}

function resolveSupportedWindowsCommand(params: {
  command: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
}): string {
  if (process.platform !== "win32") {
    return params.command;
  }
  let resolved = resolveWindowsCommandFromCwdOrPath(params);
  const shimmedCommand = resolveWindowsCommandShim({
    command: params.command,
    cmdCommands: ["corepack", "pnpm", "yarn"],
  });
  if (!resolved && shimmedCommand !== params.command) {
    resolved = resolveWindowsCommandFromCwdOrPath({ ...params, command: shimmedCommand });
  }
  if (!resolved) {
    // Execa delegates Windows parsing to cross-spawn, which otherwise falls
    // through to ambient ComSpec even with shell:false.
    throw createWindowsCommandNotFoundError(params.command);
  }
  const extension = normalizeLowercaseStringOrEmpty(path.extname(resolved));
  if ([".exe", ".com", ".cmd", ".bat"].includes(extension)) {
    return resolved;
  }
  throw new Error(
    `Unsupported Windows command extension ${JSON.stringify(extension || "<none>")} for ${JSON.stringify(params.command)}; use an explicit executable or shell wrapper.`,
  );
}

type SafeChildProcessInvocation = {
  args: string[];
  command: string;
  usesWindowsExitCodeShim: boolean;
  windowsHide: true;
  windowsVerbatimArguments?: boolean;
};

/** Resolve one shell-free invocation before Execa can apply Windows fallbacks. */
export function resolveSafeChildProcessInvocation(params: {
  argv: string[];
  cwd?: string | URL;
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}): SafeChildProcessInvocation {
  const finalArgv = resolveNpmArgvForWindows(params.argv) ?? params.argv;
  const cwd = params.cwd instanceof URL ? fileURLToPath(params.cwd) : params.cwd;
  const resolvedCommand = resolveSupportedWindowsCommand({
    command: finalArgv[0] ?? "",
    cwd,
    env: params.env,
  });
  const useCmdWrapper = isWindowsBatchCommand(resolvedCommand);
  const command = useCmdWrapper
    ? resolveSupportedWindowsCommand({
        command: resolveTrustedWindowsCmdExe(),
        cwd,
        env: params.env,
      })
    : resolvedCommand;

  return {
    command,
    args: useCmdWrapper
      ? ["/d", "/s", "/c", buildWindowsCmdExeCommandLine(resolvedCommand, finalArgv.slice(1))]
      : finalArgv.slice(1),
    usesWindowsExitCodeShim:
      process.platform === "win32" && (useCmdWrapper || finalArgv !== params.argv),
    windowsHide: true,
    windowsVerbatimArguments: useCmdWrapper ? true : params.windowsVerbatimArguments,
  };
}

export function isWindowsBatchCommand(
  resolvedCommand: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") {
    return false;
  }
  const ext = normalizeLowercaseStringOrEmpty(path.extname(resolvedCommand));
  return ext === ".cmd" || ext === ".bat";
}

function escapeForWindowsCmdExe(arg: string): string {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(
      `Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}. ` +
        "Pass an explicit shell-wrapper argv at the call site instead.",
    );
  }
  const escaped = arg.replace(/\^/g, "^^");
  if (!escaped.includes(" ") && !escaped.includes('"')) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, '""')}"`;
}

export function buildWindowsCmdExeCommandLine(command: string, args: readonly string[]): string {
  const escapedCommand = escapeForWindowsCmdExe(command);
  const commandLine = [escapedCommand, ...args.map(escapeForWindowsCmdExe)].join(" ");
  return escapedCommand.startsWith('"') ? `"${commandLine}"` : commandLine;
}

export function resolveTrustedWindowsCmdExe(platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") {
    return "cmd.exe";
  }
  return getWindowsCmdExePath();
}

/**
 * Resolve package-manager commands that Windows exposes through .cmd shims.
 * Explicit extensions are preserved so callers can pass already-resolved tools.
 */
export function resolveWindowsCommandShim(params: {
  command: string;
  cmdCommands: readonly string[];
  platform?: NodeJS.Platform;
}): string {
  if ((params.platform ?? process.platform) !== "win32") {
    return params.command;
  }
  const basename = normalizeLowercaseStringOrEmpty(path.basename(params.command));
  if (path.extname(basename)) {
    return params.command;
  }
  if (params.cmdCommands.includes(basename)) {
    return `${params.command}.cmd`;
  }
  return params.command;
}
