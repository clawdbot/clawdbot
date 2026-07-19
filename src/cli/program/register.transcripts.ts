// `openclaw transcripts`: local state inspector for stored transcript metadata and summaries.
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { resolveStateDir } from "../../config/paths.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { TranscriptSessionDescriptor } from "../../transcripts/provider-types.js";

type TranscriptsCliOptions = {
  json?: boolean;
};

type TranscriptsPathOptions = TranscriptsCliOptions & {
  dir?: boolean;
  metadata?: boolean;
  transcript?: boolean;
};

type StoredTranscriptsSession = {
  session: TranscriptSessionDescriptor;
  sessionDir: string;
  date: string;
  summaryPath: string;
  hasSummary: boolean;
};

const TRANSCRIPTS_STATE_SUBDIR = "transcripts";

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function stateRootDir(): string {
  return path.join(resolveStateDir(), TRANSCRIPTS_STATE_SUBDIR);
}

function dateFromSessionId(sessionId: string): string | undefined {
  return sessionId
    .match(/^transcript-(\d{4})-(\d{2})-(\d{2})T/)
    ?.slice(1, 4)
    .join("-");
}

function sessionDir(date: string, sessionId: string): string {
  return path.join(stateRootDir(), date, safeSegment(sessionId));
}

// Selectors are date-qualified when duplicate session ids can exist across transcript days.
function readDateFromSessionDir(sessionDirValue: string): string {
  const candidate = path.basename(path.dirname(sessionDirValue));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    throw new Error(`invalid transcripts date directory: ${candidate}`);
  }
  return candidate;
}

function formatSelector(entry: StoredTranscriptsSession): string {
  return `${entry.date}/${safeSegment(entry.session.sessionId)}`;
}

function parseQualifiedSelector(selector: string): { date: string; sessionId: string } | null {
  const match = selector.match(/^(\d{4}-\d{2}-\d{2})\/(.+)$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { date: match[1], sessionId: match[2] };
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

function writeJson(value: unknown): void {
  writeLine(
    JSON.stringify(value, null, 2).replace(
      /[\u007f-\u009f]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ),
  );
}

function isNodeError(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && err.code === code);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if (isNodeError(err, "ENOENT")) {
      return false;
    }
    throw err;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readStoredSession(
  sessionDirLocal: string,
  options: { ignoreInvalid?: boolean } = {},
): Promise<StoredTranscriptsSession | null> {
  const metadataPath = path.join(sessionDirLocal, "metadata.json");
  try {
    const session = await readJsonFile<TranscriptSessionDescriptor>(metadataPath);
    const summaryPath = path.join(sessionDirLocal, "summary.md");
    return {
      session,
      sessionDir: sessionDirLocal,
      date: readDateFromSessionDir(sessionDirLocal),
      summaryPath,
      hasSummary: await pathExists(summaryPath),
    };
  } catch (err) {
    if (isNodeError(err, "ENOENT")) {
      return null;
    }
    if (options.ignoreInvalid) {
      return null;
    }
    throw new Error(`invalid transcripts metadata at ${metadataPath}: ${formatErrorMessage(err)}`, {
      cause: err,
    });
  }
}

async function listStoredSessionDirs(): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(stateRootDir(), { withFileTypes: true });
  } catch (err) {
    if (isNodeError(err, "ENOENT")) {
      return [];
    }
    throw err;
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const firstLevelDir = path.join(stateRootDir(), entry.name);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
      continue;
    }
    const nestedEntries = await fs.readdir(firstLevelDir, { withFileTypes: true });
    dirs.push(
      ...nestedEntries
        .filter((nestedEntry) => nestedEntry.isDirectory())
        .map((nestedEntry) => path.join(firstLevelDir, nestedEntry.name)),
    );
  }
  return dirs;
}

function assertRequestedSession(
  entry: StoredTranscriptsSession,
  sessionId: string,
): StoredTranscriptsSession {
  if (entry.session.sessionId !== sessionId && safeSegment(entry.session.sessionId) !== sessionId) {
    throw new Error(
      `transcripts metadata mismatch for ${sessionId}: found ${entry.session.sessionId}`,
    );
  }
  return entry;
}

async function requireStoredSession(selector: string): Promise<StoredTranscriptsSession> {
  const qualified = parseQualifiedSelector(selector);
  if (qualified) {
    const session = await readStoredSession(sessionDir(qualified.date, qualified.sessionId));
    if (!session) {
      throw new Error(`transcripts session not found: ${selector}`);
    }
    return assertRequestedSession(session, qualified.sessionId);
  }

  const idDate = dateFromSessionId(selector);
  const session = idDate ? await readStoredSession(sessionDir(idDate, selector)) : null;
  if (session) {
    return assertRequestedSession(session, selector);
  }
  const sessions = await listStoredSessions();
  const matches = sessions.filter(
    (entry) =>
      entry.session.sessionId === selector || safeSegment(entry.session.sessionId) === selector,
  );
  if (matches.length === 1 && matches[0]) {
    return assertRequestedSession(matches[0], selector);
  }
  if (matches.length > 1) {
    throw new Error(
      `multiple transcripts sessions match ${selector}; use one of: ${matches
        .map(formatSelector)
        .join(", ")}`,
    );
  }
  throw new Error(`transcripts session not found: ${selector}`);
}

async function listStoredSessions(): Promise<StoredTranscriptsSession[]> {
  const dirs = await listStoredSessionDirs();
  const sessions = await Promise.all(
    dirs.map((dir) =>
      readStoredSession(dir, {
        ignoreInvalid: true,
      }),
    ),
  );
  return sessions
    .filter((session): session is StoredTranscriptsSession => session !== null)
    .toSorted((left, right) =>
      (right.session.startedAt ?? "").localeCompare(left.session.startedAt ?? ""),
    );
}

function formatSessionLine(entry: StoredTranscriptsSession): string {
  const title = sanitizeTerminalText(entry.session.title?.trim() || "Transcripts");
  const started = sanitizeTerminalText(entry.session.startedAt || "unknown");
  const summary = sanitizeTerminalText(entry.hasSummary ? entry.summaryPath : "no summary.md");
  return `${formatSelector(entry)}\t${started}\t${title}\t${summary}`;
}

function sanitizeMarkdownForTerminal(markdown: string): string {
  return markdown.split("\n").map(sanitizeTerminalText).join("\n");
}

async function listCommand(options: TranscriptsCliOptions): Promise<void> {
  const sessions = await listStoredSessions();
  if (options.json) {
    writeJson(
      sessions.map((entry) => ({
        sessionId: entry.session.sessionId,
        selector: formatSelector(entry),
        date: entry.date,
        title: entry.session.title,
        startedAt: entry.session.startedAt,
        stoppedAt: entry.session.stoppedAt,
        source: entry.session.source,
        path: entry.sessionDir,
        summaryPath: entry.summaryPath,
        hasSummary: entry.hasSummary,
      })),
    );
    return;
  }
  if (sessions.length === 0) {
    writeLine("No transcripts found.");
    return;
  }
  for (const session of sessions) {
    writeLine(formatSessionLine(session));
  }
}

async function showCommand(sessionId: string, options: TranscriptsCliOptions): Promise<void> {
  const session = await requireStoredSession(sessionId);
  if (options.json) {
    const summary = session.hasSummary ? await fs.readFile(session.summaryPath, "utf8") : null;
    writeJson({
      session: session.session,
      selector: formatSelector(session),
      path: session.sessionDir,
      summaryPath: session.summaryPath,
      summary,
    });
    return;
  }
  if (!session.hasSummary) {
    throw new Error(`summary.md not found for transcripts session: ${sessionId}`);
  }
  process.stdout.write(sanitizeMarkdownForTerminal(await fs.readFile(session.summaryPath, "utf8")));
}

async function pathCommand(selector: string, options: TranscriptsPathOptions): Promise<void> {
  const session = await requireStoredSession(selector);
  const selectedPath = options.dir
    ? session.sessionDir
    : options.metadata
      ? path.join(session.sessionDir, "metadata.json")
      : options.transcript
        ? path.join(session.sessionDir, "transcript.jsonl")
        : session.summaryPath;
  if (options.json) {
    writeJson({
      sessionId: session.session.sessionId,
      selector: formatSelector(session),
      path: selectedPath,
      exists: await pathExists(selectedPath),
    });
    return;
  }
  writeLine(selectedPath);
}

/** Register transcript list/show/path inspection commands. */
export function registerTranscriptsCli(program: Command): void {
  const transcripts = program.command("transcripts").description("Inspect stored transcripts");

  transcripts
    .command("list")
    .description("List stored transcript sessions")
    .option("--json", "Print JSON")
    .action(async (options: TranscriptsCliOptions) => {
      await listCommand(options);
    });

  transcripts
    .command("show")
    .description("Print a transcript summary markdown file")
    .argument("<session>", "Transcripts session id or YYYY-MM-DD/session selector")
    .option("--json", "Print JSON")
    .action(async (sessionId: string, options: TranscriptsCliOptions) => {
      await showCommand(sessionId, options);
    });

  transcripts
    .command("path")
    .description("Print a stored transcripts artifact path")
    .argument("<session>", "Transcripts session id or YYYY-MM-DD/session selector")
    .option("--dir", "Print the session directory")
    .option("--metadata", "Print metadata.json")
    .option("--transcript", "Print transcript.jsonl")
    .option("--json", "Print JSON")
    .action(async (sessionId: string, options: TranscriptsPathOptions) => {
      await pathCommand(sessionId, options);
    });
}
