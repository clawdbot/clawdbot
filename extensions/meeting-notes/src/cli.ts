import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import type { MeetingNotesSessionDescriptor } from "openclaw/plugin-sdk/meeting-notes";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

type MeetingNotesCliOptions = {
  json?: boolean;
};

type MeetingNotesPathOptions = MeetingNotesCliOptions & {
  dir?: boolean;
  metadata?: boolean;
  transcript?: boolean;
};

type StoredMeetingNotesSession = {
  session: MeetingNotesSessionDescriptor;
  sessionDir: string;
  date: string;
  summaryPath: string;
  hasSummary: boolean;
};

const MEETING_NOTES_STATE_SUBDIR = "meeting-notes";

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function stateRootDir(): string {
  return path.join(resolveStateDir(), MEETING_NOTES_STATE_SUBDIR);
}

function dateFromSessionId(sessionId: string): string | undefined {
  return sessionId
    .match(/^meeting-(\d{4})-(\d{2})-(\d{2})T/)
    ?.slice(1, 4)
    .join("-");
}

function sessionDir(date: string, sessionId: string): string {
  return path.join(stateRootDir(), date, safeSegment(sessionId));
}

function readDateFromSessionDir(sessionDir: string): string {
  const candidate = path.basename(path.dirname(sessionDir));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    throw new Error(`invalid meeting notes date directory: ${candidate}`);
  }
  return candidate;
}

function formatSelector(entry: StoredMeetingNotesSession): string {
  return `${entry.date}/${entry.session.sessionId}`;
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
  writeLine(JSON.stringify(value, null, 2));
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

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readStoredSession(
  sessionDir: string,
  options: { ignoreInvalid?: boolean } = {},
): Promise<StoredMeetingNotesSession | null> {
  const metadataPath = path.join(sessionDir, "metadata.json");
  try {
    const session = await readJsonFile<MeetingNotesSessionDescriptor>(metadataPath);
    const summaryPath = path.join(sessionDir, "summary.md");
    return {
      session,
      sessionDir,
      date: readDateFromSessionDir(sessionDir),
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
    throw new Error(
      `invalid meeting notes metadata at ${metadataPath}: ${formatErrorMessage(err)}`,
      {
        cause: err,
      },
    );
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
  entry: StoredMeetingNotesSession,
  sessionId: string,
): StoredMeetingNotesSession {
  if (entry.session.sessionId !== sessionId) {
    throw new Error(
      `meeting notes metadata mismatch for ${sessionId}: found ${entry.session.sessionId}`,
    );
  }
  return entry;
}

async function requireStoredSession(selector: string): Promise<StoredMeetingNotesSession> {
  const qualified = parseQualifiedSelector(selector);
  if (qualified) {
    const session = await readStoredSession(sessionDir(qualified.date, qualified.sessionId));
    if (!session) {
      throw new Error(`meeting notes session not found: ${selector}`);
    }
    return assertRequestedSession(session, qualified.sessionId);
  }

  const idDate = dateFromSessionId(selector);
  const session = idDate ? await readStoredSession(sessionDir(idDate, selector)) : null;
  if (session) {
    return assertRequestedSession(session, selector);
  }
  const sessions = await listStoredSessions();
  const matches = sessions.filter((entry) => entry.session.sessionId === selector);
  if (matches.length === 1 && matches[0]) {
    return assertRequestedSession(matches[0], selector);
  }
  if (matches.length > 1) {
    throw new Error(
      `multiple meeting notes sessions match ${selector}; use one of: ${matches
        .map(formatSelector)
        .join(", ")}`,
    );
  }
  throw new Error(`meeting notes session not found: ${selector}`);
}

async function listStoredSessions(): Promise<StoredMeetingNotesSession[]> {
  const dirs = await listStoredSessionDirs();
  const sessions = await Promise.all(
    dirs.map((dir) =>
      readStoredSession(dir, {
        ignoreInvalid: true,
      }),
    ),
  );
  return sessions
    .filter((session): session is StoredMeetingNotesSession => session !== null)
    .toSorted((left, right) =>
      (right.session.startedAt ?? "").localeCompare(left.session.startedAt ?? ""),
    );
}

function formatSessionLine(entry: StoredMeetingNotesSession): string {
  const title = entry.session.title?.trim() || "Meeting notes";
  const started = entry.session.startedAt || "unknown";
  const summary = entry.hasSummary ? entry.summaryPath : "no summary.md";
  return `${formatSelector(entry)}\t${started}\t${title}\t${summary}`;
}

async function listCommand(options: MeetingNotesCliOptions): Promise<void> {
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
    writeLine("No meeting notes found.");
    return;
  }
  for (const session of sessions) {
    writeLine(formatSessionLine(session));
  }
}

async function showCommand(sessionId: string, options: MeetingNotesCliOptions): Promise<void> {
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
    throw new Error(`summary.md not found for meeting notes session: ${sessionId}`);
  }
  process.stdout.write(await fs.readFile(session.summaryPath, "utf8"));
}

async function pathCommand(selector: string, options: MeetingNotesPathOptions): Promise<void> {
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

export function registerMeetingNotesCli(program: Command): void {
  const meetingNotes = program.command("meeting-notes").description("Inspect stored meeting notes");

  meetingNotes
    .command("list")
    .description("List stored meeting note sessions")
    .option("--json", "Print JSON")
    .action(async (options: MeetingNotesCliOptions) => {
      await listCommand(options);
    });

  meetingNotes
    .command("show")
    .description("Print a meeting summary markdown file")
    .argument("<session>", "Meeting notes session id or YYYY-MM-DD/session selector")
    .option("--json", "Print JSON")
    .action(async (sessionId: string, options: MeetingNotesCliOptions) => {
      await showCommand(sessionId, options);
    });

  meetingNotes
    .command("path")
    .description("Print a stored meeting notes artifact path")
    .argument("<session>", "Meeting notes session id or YYYY-MM-DD/session selector")
    .option("--dir", "Print the session directory")
    .option("--metadata", "Print metadata.json")
    .option("--transcript", "Print transcript.jsonl")
    .option("--json", "Print JSON")
    .action(async (sessionId: string, options: MeetingNotesPathOptions) => {
      await pathCommand(sessionId, options);
    });
}
