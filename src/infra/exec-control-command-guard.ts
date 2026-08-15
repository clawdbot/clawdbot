import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { splitShellArgs } from "../utils/shell-argv.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import {
  buildCommandPayloadArgvCandidates,
  buildCommandPayloadCandidates,
} from "./command-analysis/risks.js";
import { explainShellCommand } from "./command-explainer/extract.js";
import { isPathInside } from "./path-guards.js";

type ParsedExecApprovalCommand = {
  approvalId: string;
  decision: "allow-once" | "allow-always" | "deny";
};

type UnsafeExecControlShellCommandKind = "approve" | "channel-login" | "live-state-sqlite";

type ExecControlShellCommandContext = {
  stateDir?: string;
  workdir?: string;
};

const SQLITE_OPTIONS_WITH_VALUES = new Map<string, number>([
  ["cmd", 1],
  ["escape", 1],
  ["heap", 1],
  ["init", 1],
  ["lookaside", 2],
  ["maxsize", 1],
  ["mmap", 1],
  ["newline", 1],
  ["nonce", 1],
  ["nullvalue", 1],
  ["pagecache", 2],
  ["separator", 1],
  ["vfs", 1],
]);

const SQLITE_OPEN_OPTIONS_WITH_VALUES = new Map<string, number>([
  ["hexkey", 1],
  ["key", 1],
  ["maxsize", 1],
  ["textkey", 1],
]);

function parseExecApprovalShellCommand(raw: string): ParsedExecApprovalCommand | null {
  const normalized = raw.trimStart();
  const match = normalized.match(
    /^\/approve(?:@[^\s]+)?\s+([A-Za-z0-9][A-Za-z0-9._:-]*)\s+(allow-once|allow-always|always|deny)\b/i,
  );
  if (!match) {
    return null;
  }
  return {
    approvalId: expectDefined(match[1], "exec control command guard regex capture 1"),
    decision:
      normalizeLowercaseStringOrEmpty(match[2]) === "always"
        ? "allow-always"
        : (normalizeLowercaseStringOrEmpty(match[2]) as ParsedExecApprovalCommand["decision"]),
  };
}

function normalizeCommandBaseName(token: string | undefined): string {
  if (!token) {
    return "";
  }
  const base = normalizeLowercaseStringOrEmpty(token.split(/[\\/]/u).at(-1));
  return base.replace(/\.(?:cmd|exe)$/u, "");
}

function stripOpenClawPackageRunner(argv: string[]): string[] {
  const commandName = normalizeCommandBaseName(argv[0]);
  if (commandName === "openclaw") {
    return argv;
  }
  if (
    (commandName === "pnpm" || commandName === "npm" || commandName === "yarn") &&
    normalizeCommandBaseName(argv[1]) === "openclaw"
  ) {
    return argv.slice(1);
  }
  if (
    (commandName === "pnpm" || commandName === "npm" || commandName === "yarn") &&
    (argv[1] === "exec" || argv[1] === "dlx" || argv[1] === "run") &&
    normalizeCommandBaseName(argv[2]) === "openclaw"
  ) {
    return argv.slice(2);
  }
  if (commandName === "npx" || commandName === "bunx") {
    let idx = 1;
    while (idx < argv.length) {
      const token = expectDefined(argv[idx], "argv entry at idx");
      if (token === "--") {
        idx += 1;
        break;
      }
      if (!token.startsWith("-") || token === "-") {
        break;
      }
      idx += 1;
      if ((token === "-p" || token === "--package") && idx < argv.length) {
        idx += 1;
      }
    }
    if (normalizeCommandBaseName(argv[idx]) === "openclaw") {
      return argv.slice(idx);
    }
  }
  return argv;
}

function parseOpenClawChannelsLoginShellCommand(raw: string): boolean {
  const argv = splitShellArgs(raw);
  if (!argv) {
    return false;
  }
  const openclawArgv = stripOpenClawPackageRunner(argv);
  return (
    normalizeCommandBaseName(openclawArgv[0]) === "openclaw" &&
    (openclawArgv[1] === "channels" || openclawArgv[1] === "channel") &&
    openclawArgv[2] === "login"
  );
}

function parseSqliteOpenCommandDatabaseToken(command: string): string | null {
  const argv = splitShellArgs(command);
  if (!argv || !/^\.op(?:e(?:n)?)?$/u.test(argv[0] ?? "")) {
    return null;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const token = expectDefined(argv[index], "sqlite3 .open argv entry");
    if (token === "--") {
      return argv[index + 1] ?? null;
    }
    if (token === "-" || !token.startsWith("-")) {
      return token;
    }
    const optionName = token.replace(/^-+/u, "").split("=", 1)[0]?.toLowerCase() ?? "";
    if (!token.includes("=")) {
      index += SQLITE_OPEN_OPTIONS_WITH_VALUES.get(optionName) ?? 0;
    }
  }
  return null;
}

function parseSqliteDatabaseTokens(argv: string[]): string[] {
  if (normalizeCommandBaseName(argv[0]) !== "sqlite3") {
    return [];
  }
  const databaseTokens: string[] = [];
  const commandTokens: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = expectDefined(argv[index], "sqlite3 argv entry");
    if (token === "--") {
      const databaseToken = argv[index + 1];
      if (databaseToken) {
        databaseTokens.push(databaseToken);
      }
      commandTokens.push(...argv.slice(index + 2));
      break;
    }
    if (token === "-" || !token.startsWith("-")) {
      databaseTokens.push(token);
      commandTokens.push(...argv.slice(index + 1));
      break;
    }
    const optionName = token.replace(/^-+/u, "").split("=", 1)[0]?.toLowerCase() ?? "";
    if (optionName === "cmd") {
      const commandToken = token.includes("=")
        ? token.slice(token.indexOf("=") + 1)
        : argv[index + 1];
      if (commandToken) {
        commandTokens.push(commandToken);
      }
    }
    if (!token.includes("=")) {
      index += SQLITE_OPTIONS_WITH_VALUES.get(optionName) ?? 0;
    }
  }
  for (const commandToken of commandTokens) {
    const databaseToken = parseSqliteOpenCommandDatabaseToken(commandToken);
    if (databaseToken) {
      databaseTokens.push(databaseToken);
    }
  }
  return databaseTokens;
}

function expandSqliteDatabaseToken(token: string, stateDir: string): string | null {
  let expanded = token.trim();
  if (!expanded || expanded === ":memory:") {
    return null;
  }
  const stateVariable = expanded.match(
    /^\$(?:OPENCLAW_STATE_DIR|\{OPENCLAW_STATE_DIR\})(?=$|[\\/])/u,
  );
  if (stateVariable) {
    expanded = `${stateDir}${expanded.slice(stateVariable[0].length)}`;
  }
  const homeVariable = expanded.match(/^\$(?:HOME|\{HOME\})(?=$|[\\/])/u);
  if (homeVariable) {
    expanded = `${os.homedir()}${expanded.slice(homeVariable[0].length)}`;
  }
  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  if (expanded.toLowerCase().startsWith("file:")) {
    try {
      expanded = fileURLToPath(expanded);
    } catch {
      const filename = expanded.slice("file:".length).split(/[?#]/u, 1)[0];
      if (!filename) {
        return null;
      }
      try {
        expanded = decodeURIComponent(filename);
      } catch {
        expanded = filename;
      }
    }
  }
  return expanded;
}

function targetsLiveStateSqliteDatabase(
  argv: string[],
  context: ExecControlShellCommandContext,
): boolean {
  const stateDir = context.stateDir?.trim();
  if (!stateDir) {
    return false;
  }
  // External SQLite clients bypass OpenClaw's runtime/version guard and can join the live WAL.
  // Resolve existing ancestors so an alias outside the state root cannot hide that ownership.
  const canonicalStateDir = resolvePathViaExistingAncestorSync(stateDir);
  return parseSqliteDatabaseTokens(argv).some((databaseToken) => {
    const expandedTarget = expandSqliteDatabaseToken(databaseToken, stateDir);
    if (!expandedTarget) {
      return false;
    }
    const targetPath = path.isAbsolute(expandedTarget)
      ? expandedTarget
      : path.resolve(context.workdir ?? process.cwd(), expandedTarget);
    const canonicalTarget = resolvePathViaExistingAncestorSync(targetPath);
    return (
      canonicalTarget === canonicalStateDir || isPathInside(canonicalStateDir, canonicalTarget)
    );
  });
}

export async function detectUnsafeExecControlShellCommand(
  command: string,
  context: ExecControlShellCommandContext = {},
): Promise<UnsafeExecControlShellCommandKind | null> {
  const rawCommand = command.trim();
  const { controlCandidates, argvCandidates } = await (async () => {
    try {
      const explanation = await explainShellCommand(rawCommand);
      if (explanation.ok) {
        const commands = [...explanation.topLevelCommands, ...explanation.nestedCommands];
        return {
          controlCandidates: commands.flatMap((step) => buildCommandPayloadCandidates(step.argv)),
          argvCandidates: commands.flatMap((step) => buildCommandPayloadArgvCandidates(step.argv)),
        };
      }
    } catch {
      // Fall back to line-local shell splitting below.
    }
    const fallbackArgv = normalizeStringEntries(rawCommand.split(/\r?\n/)).map((line) => {
      const argv = splitShellArgs(line);
      return { argv, line };
    });
    return {
      controlCandidates: fallbackArgv.flatMap(({ argv, line }) =>
        argv ? buildCommandPayloadCandidates(argv) : [line],
      ),
      argvCandidates: fallbackArgv.flatMap(({ argv, line }) =>
        argv ? buildCommandPayloadArgvCandidates(argv) : [[line]],
      ),
    };
  })();
  for (const candidate of controlCandidates) {
    if (parseExecApprovalShellCommand(candidate)) {
      return "approve";
    }
    if (parseOpenClawChannelsLoginShellCommand(candidate)) {
      return "channel-login";
    }
  }
  for (const candidateArgv of argvCandidates) {
    if (targetsLiveStateSqliteDatabase(candidateArgv, context)) {
      return "live-state-sqlite";
    }
  }
  return null;
}

export async function rejectUnsafeExecControlShellCommand(command: string): Promise<void> {
  const unsafeKind = await detectUnsafeExecControlShellCommand(command);
  if (unsafeKind === "approve") {
    throw new Error(
      [
        "exec cannot run /approve commands.",
        "Show the /approve command to the user as chat text, or route it through the approval command handler instead of shell execution.",
      ].join(" "),
    );
  }
  if (unsafeKind === "channel-login") {
    throw new Error(
      [
        "exec cannot run interactive OpenClaw channel login commands.",
        "Run `openclaw channels login` in a terminal on the gateway host, or use the channel-specific login agent tool when available (for WhatsApp: `whatsapp_login`).",
      ].join(" "),
    );
  }
}

export async function rejectUnsafeExecLiveStateSqliteShellCommand(
  command: string,
  context: Required<ExecControlShellCommandContext>,
): Promise<void> {
  const unsafeKind = await detectUnsafeExecControlShellCommand(command, context);
  if (unsafeKind !== "live-state-sqlite") {
    return;
  }
  throw new Error(
    [
      "external sqlite3 cannot open databases under the active OpenClaw state directory.",
      "Use OpenClaw commands for live state, or inspect a private backup copy outside `OPENCLAW_STATE_DIR`.",
    ].join(" "),
  );
}
