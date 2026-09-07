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
import {
  CommandExplanationWorkLimitError,
  explainShellCommand,
} from "./command-explainer/extract.js";
import type { CommandExplanation } from "./command-explainer/types.js";
import { isPathInside } from "./path-guards.js";

type ParsedExecApprovalCommand = {
  approvalId: string;
  decision: "allow-once" | "allow-always" | "deny";
};

type UnsafeExecControlShellCommandKind =
  | "approve"
  | "channel-login"
  | "live-state-sqlite"
  | "incomplete-analysis";

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

// Join line continuations strictly *inside* shell words. tree-sitter-bash
// word-breaks at `\<newline>` while POSIX sh joins, which hides control
// words from the guard (e.g. `/appr\<newline>ove` executes as `/approve`
// but parses as `/appr` + `ove`). A pair is joined only when an odd-length
// backslash run at end-of-line is flanked by word characters on both sides:
//   - comment lines are untouched (a `#` comment ends at the newline, so
//     joining would swallow the following command); lines containing `#`
//     anywhere before the pair are skipped too (a joined word keeping a
//     literal `#` can never equal a `#`-free control word, so skipping is
//     safe for control matching);
//   - even runs are untouched (literal backslashes + a real separator);
//   - `\` + CRLF is untouched (not a continuation for the shell);
//   - quoted here-document bodies are untouched: joining `x\` + `EOF` would
//     move the terminator and swallow the following command into the body
//     only in the rewritten input, while the shell executes it (verified
//     vs sh). Unquoted bodies DO join (verified: the shell joins there and
//     even a split terminator `E\`+`OF` terminates), so they are processed
//     like code, minus operator scanning (body text opens no heredocs).
// The replacement keeps (N-1)/2 literal backslashes, mirroring incremental
// shell tokenization (re-emitting the newline would falsely escape the
// character that follows it in a fresh parse).
type HeredocFrame = { delim: string; stripTabs: boolean; quoted: boolean };

// Finds `<<[-]delimiter` operators on one raw physical line, skipping
// anything inside single/double quotes and trailing `#` comments — but the
// delimiter itself may be quoted (`<<'EOF'`), so quotes are tracked rather
// than stripped. `<<<` herestrings are skipped (no body follows).
function scanHeredocOperators(line: string): HeredocFrame[] {
  const frames: HeredocFrame[] = [];
  let i = 0;
  let squote = false;
  let dquote = false;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (squote) {
      if (ch === "'") {
        squote = false;
      }
      i += 1;
      continue;
    }
    if (dquote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') {
        dquote = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      squote = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      dquote = true;
      i += 1;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;|&()<>]/.test(line[i - 1] ?? ""))) {
      break;
    }
    if (ch === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      let j = i + 2;
      let stripTabs = false;
      if (line[j] === "-") {
        stripTabs = true;
        j += 1;
      }
      while (line[j] === " " || line[j] === "\t") {
        j += 1;
      }
      let delim = "";
      let quoted = false;
      const q = line[j];
      if (q === "'" || q === '"') {
        const end = line.indexOf(q, j + 1);
        if (end !== -1) {
          delim = line.slice(j + 1, end);
          quoted = true;
          j = end + 1;
        }
      } else {
        if (line[j] === "\\" && j + 1 < n) {
          quoted = true;
          j += 1;
        }
        const start = j;
        while (j < n && /[A-Za-z0-9_]/.test(line[j] ?? "")) {
          j += 1;
        }
        delim = line.slice(start, j);
      }
      if (delim.length > 0) {
        frames.push({ delim, stripTabs, quoted });
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return frames;
}

function joinEolPair(line: string, nextLine: string): string {
  return line.replace(
    /^(?!\s*#)([^#\n]*?)([^\s;|&()<>"'`#$\n\\])(\\+)$/g,
    (match, prefix, before, run) => {
      if ((run as string).length % 2 === 0) {
        return match;
      }
      if (!/^[^\s;|&()<>"'`#$\n\\]/.test(nextLine)) {
        return match;
      }
      return (prefix as string) + (before as string) + "\\".repeat(((run as string).length - 1) / 2);
    },
  );
}

function joinWordInternalLineContinuations(command: string): string {
  const lines = command.split("\n");
  const pending: HeredocFrame[] = [];
  const out: string[] = [];
  const isTerminator = (line: string, frame: HeredocFrame): boolean => {
    const cmp = frame.stripTabs ? line.replace(/^\t+/, "") : line;
    return cmp === frame.delim;
  };
  let i = 0;
  while (i < lines.length) {
    // Index access is guarded by the loop bound; the `?? ""` only satisfies
    // `noUncheckedIndexedAccess`.
    const line: string = lines[i] ?? "";
    const top = pending[0];
    if (top && top.quoted) {
      // Quoted here-document: body lines are literal, so they are never
      // joined; only the exact terminator ends the body.
      if (isTerminator(line, top)) {
        pending.shift();
      }
      out.push(line);
      i += 1;
      continue;
    }
    if (i === lines.length - 1) {
      if (!top) {
        for (const f of scanHeredocOperators(line)) {
          if (f.delim.length > 0) {
            pending.push(f);
          }
        }
      } else if (isTerminator(line, top)) {
        pending.shift();
      }
      out.push(line);
      i += 1;
      continue;
    }
    // Code lines and unquoted-heredoc body lines both follow incremental
    // shell tokenization: an odd `\` run joins with the next line, which is
    // then consumed into this logical line (it is not body/a terminator on
    // its own — verified vs sh). A joined line can itself be a terminator
    // (`E\` + `OF` ends `<<EOF`); the check below runs on the joined text.
    // Operators are scanned on the joined logical line, since a consumed
    // physical line may carry them (`echo a \` + `cat <<EOF` opens `EOF`).
    // Body text itself opens no heredocs, so only code lines are scanned.
    const joined = joinEolPair(line, lines[i + 1] ?? "");
    // A successful join strips the continuation backslash from this line;
    // the next line's text belongs to the same logical line, so it is
    // appended here and consumed (skipped) below — mirroring the shell.
    const logical = joined !== line ? joined + (lines[i + 1] ?? "") : line;
    if (!top) {
      for (const f of scanHeredocOperators(logical)) {
        if (f.delim.length > 0) {
          pending.push(f);
        }
      }
    } else if (isTerminator(logical, top)) {
      pending.shift();
    }
    out.push(logical);
    i += joined !== line ? 2 : 1;
  }
  return out.join("\n");
}

export async function detectUnsafeExecControlShellCommand(
  command: string,
  context: ExecControlShellCommandContext = {},
): Promise<UnsafeExecControlShellCommandKind | null> {
  const rawCommand = joinWordInternalLineContinuations(command).trim();
  let explanation: CommandExplanation | null = null;
  try {
    explanation = await explainShellCommand(rawCommand);
  } catch (error) {
    if (error instanceof CommandExplanationWorkLimitError) {
      return "incomplete-analysis";
    }
    // Fall back to line-local shell splitting below.
  }
  const { controlCandidates, argvCandidates } = (() => {
    if (explanation?.ok) {
      const commands = [...explanation.topLevelCommands, ...explanation.nestedCommands];
      return {
        controlCandidates: commands.flatMap((step) => buildCommandPayloadCandidates(step.argv)),
        argvCandidates: commands.flatMap((step) => buildCommandPayloadArgvCandidates(step.argv)),
      };
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

function rejectIncompleteCommandAnalysis(
  unsafeKind: UnsafeExecControlShellCommandKind | null,
): void {
  if (unsafeKind === "incomplete-analysis") {
    throw new Error(
      "exec cannot run a shell command that exceeds the command explanation work limit. Simplify the command so its complete syntax can be inspected before execution.",
    );
  }
}

export async function rejectUnsafeExecControlShellCommand(command: string): Promise<void> {
  const unsafeKind = await detectUnsafeExecControlShellCommand(command);
  rejectIncompleteCommandAnalysis(unsafeKind);
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
  rejectIncompleteCommandAnalysis(unsafeKind);
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
