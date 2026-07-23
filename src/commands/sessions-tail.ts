/**
 * Session trajectory tail command.
 *
 * It selects active or requested sessions, renders recent trajectory events,
 * and can follow append-only trajectory files across rotation/truncation.
 */
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { getRuntimeConfig } from "../config/config.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveStoredSessionKeyForAgentStore } from "../gateway/session-store-key.js";
import { formatErrorMessage } from "../infra/errors.js";
import { readFileWindowFullySync } from "../infra/file-read.js";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";
import { readRegularFileSync } from "../infra/regular-file.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { TRAJECTORY_RUNTIME_FILE_MAX_BYTES } from "../trajectory/paths.js";
import { loadSqliteTrajectoryRuntimeEventRowsSync } from "../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../trajectory/types.js";
import { resolveSessionStoreTargetsOrExit } from "./session-store-targets.js";
import { shortenText } from "./text-format.js";

type SessionsTailOptions = {
  store?: string;
  agent?: string;
  allAgents?: boolean;
  sessionKey?: string;
  follow?: boolean;
  tail?: string | number;
};

type TailSelection = {
  agentId: string;
  key: string;
  entry: SessionEntry;
  storePath: string;
  source: TailTrajectorySource;
};

type TailTrajectorySource =
  | {
      kind: "file";
      path: string;
    }
  | {
      agentId: string;
      kind: "sqlite";
      sessionId: string;
      storePath: string;
    };

type FileFollowState = {
  cursor: TrajectoryCursor | null;
  decoder: StringDecoder;
  fileState: FollowFileState | null;
  kind: "file";
  offset: number;
  pending: string;
  selection: TailSelection & { source: Extract<TailTrajectorySource, { kind: "file" }> };
};

type SqliteFollowState = {
  cursor: TrajectoryCursor | null;
  kind: "sqlite";
  lastStorageSeq: number;
  selection: TailSelection & { source: Extract<TailTrajectorySource, { kind: "sqlite" }> };
};

type FollowState = FileFollowState | SqliteFollowState;

type TrajectorySnapshot = {
  events: TrajectoryEvent[];
  fileDecoder?: StringDecoder;
  filePending?: string;
  fileState: FollowFileState | null;
  maxStorageSeq?: number;
  offset: number;
};

type FollowFileState = {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
};

type TrajectoryCursor = {
  seq: number | null;
  tsMs: number;
};

const DEFAULT_TAIL_COUNT = 80;
const SESSION_KEY_PAD = 30;
const EVENT_TYPE_PAD = 16;
const FOLLOW_INTERVAL_MS = 1_000;
let followIntervalMsForTests: number | undefined;

/** Overrides the follow polling interval for tests. */
function setSessionsTailFollowIntervalMsForTests(intervalMs?: number): void {
  followIntervalMsForTests = intervalMs;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.sessionsTailTestApi")] = {
    setSessionsTailFollowIntervalMsForTests,
  };
}

function resolveFollowIntervalMs(): number {
  return followIntervalMsForTests ?? FOLLOW_INTERVAL_MS;
}

function parseTailCount(value: string | number | undefined): number | null {
  if (value === undefined) {
    return DEFAULT_TAIL_COUNT;
  }
  return parseStrictNonNegativeInteger(value) ?? null;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isTrajectoryEvent(value: unknown): value is TrajectoryEvent {
  return (
    isRecord(value) &&
    value.traceSchema === "openclaw-trajectory" &&
    value.schemaVersion === 1 &&
    typeof value.type === "string" &&
    typeof value.ts === "string" &&
    typeof value.sessionId === "string"
  );
}

function parseTrajectoryEventLine(line: string): TrajectoryEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isTrajectoryEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseTrajectoryEventLines(lines: string[]): TrajectoryEvent[] {
  return lines.flatMap((line) => {
    const event = parseTrajectoryEventLine(line);
    return event ? [event] : [];
  });
}

function eventSequence(event: TrajectoryEvent): number | null {
  const seq = event.sourceSeq ?? event.seq;
  return Number.isFinite(seq) ? seq : null;
}

function eventTimestampMs(event: TrajectoryEvent): number {
  const parsed = Date.parse(event.ts);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function eventCursor(event: TrajectoryEvent): TrajectoryCursor {
  return {
    seq: eventSequence(event),
    tsMs: eventTimestampMs(event),
  };
}

function compareCursors(left: TrajectoryCursor, right: TrajectoryCursor): number {
  if (left.seq !== null && right.seq !== null && left.seq !== right.seq) {
    return left.seq - right.seq;
  }
  // Some trajectory events lack sequence numbers; timestamp fallback keeps
  // follow mode from replaying already-rendered events after file rewrites.
  const byTimestamp = left.tsMs - right.tsMs;
  if (byTimestamp !== 0) {
    return byTimestamp;
  }
  if (left.seq !== null && right.seq !== null) {
    return left.seq - right.seq;
  }
  return 0;
}

function maxCursorValue(
  current: TrajectoryCursor | null,
  candidate: TrajectoryCursor,
): TrajectoryCursor {
  return !current || compareCursors(candidate, current) > 0 ? candidate : current;
}

function maxCursor(current: TrajectoryCursor | null, event: TrajectoryEvent): TrajectoryCursor {
  return maxCursorValue(current, eventCursor(event));
}

function maxCursorFromEvents(events: TrajectoryEvent[]): TrajectoryCursor | null {
  return events.reduce<TrajectoryCursor | null>((cursor, event) => maxCursor(cursor, event), null);
}

function eventsAfterCursor(
  events: TrajectoryEvent[],
  cursor: TrajectoryCursor | null,
): TrajectoryEvent[] {
  if (!cursor) {
    return events;
  }
  return events.filter((event) => compareCursors(eventCursor(event), cursor) > 0);
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return "--:--:--";
  }
  return date.toISOString().slice(11, 19);
}

function modelLabel(event: TrajectoryEvent): string | undefined {
  const provider = event.provider?.trim();
  const model = event.modelId?.trim();
  if (provider && model) {
    return `${provider}/${model}`;
  }
  return model || provider || undefined;
}

function toolName(data: Record<string, unknown> | undefined): string {
  return toOptionalString(data?.name) ?? toOptionalString(data?.toolName) ?? "tool";
}

function resultStatus(data: Record<string, unknown> | undefined): string {
  if (data?.success === true) {
    return "ok";
  }
  if (data?.success === false || data?.isError === true) {
    return "error";
  }
  return toOptionalString(data?.status) ?? "done";
}

function modelCompletionStatus(data: Record<string, unknown> | undefined): string {
  if (data?.timedOut === true) {
    return "timeout";
  }
  if (data?.aborted === true) {
    return "aborted";
  }
  if (toOptionalString(data?.promptError)) {
    return "error";
  }
  return "done";
}

function safePreview(event: TrajectoryEvent): string {
  const data = event.data;
  switch (event.type) {
    case "session.started":
      return "session started";
    case "context.compiled": {
      const tools = Array.isArray(data?.tools) ? data.tools.length : undefined;
      return tools === undefined ? "context compiled" : `context compiled (${tools} tools)`;
    }
    case "prompt.submitted":
      return "prompt submitted";
    case "prompt.skipped": {
      const reason = toOptionalString(data?.reason);
      return `prompt skipped${reason ? `: ${reason}` : ""}`;
    }
    case "tool.call":
      // Tool arguments may contain secrets or user text; tail output shows only
      // the tool name and a redacted placeholder.
      return `${toolName(data)} {...redacted...}`;
    case "tool.timeout":
      return `${toolName(data)} timeout`;
    case "tool.result":
      return `${toolName(data)} ${resultStatus(data)}`;
    case "model.completed": {
      const model = modelLabel(event);
      const status = modelCompletionStatus(data);
      return model ? `${model} ${status}` : status;
    }
    case "session.ended":
      return toOptionalString(data?.status) ?? "ended";
    case "trace.truncated":
      return "trajectory truncated";
    default:
      return toOptionalString(data?.status) ?? toOptionalString(data?.name) ?? "";
  }
}

function formatProgressLine(event: TrajectoryEvent): string {
  const sessionLabel = shortenText(event.sessionKey ?? event.sessionId, SESSION_KEY_PAD).padEnd(
    SESSION_KEY_PAD,
  );
  const typeLabel = shortenText(event.type, EVENT_TYPE_PAD).padEnd(EVENT_TYPE_PAD);
  const preview = safePreview(event);
  return [formatTimestamp(event.ts), typeLabel, sessionLabel, preview].join(" ").trimEnd();
}

function readTrajectorySnapshot(filePath: string): TrajectorySnapshot {
  try {
    // Use the runtime trajectory limit so tail accepts any file the runtime
    // would have written and rejects anything larger.
    const { buffer, stat } = readRegularFileSync({
      filePath,
      maxBytes: TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
    });
    const fileDecoder = new StringDecoder("utf8");
    const lines = fileDecoder.write(buffer).split(/\r?\n/u);
    const trailing = lines.pop() ?? "";
    const trailingEvent = parseTrajectoryEventLine(trailing);
    return {
      events: [...parseTrajectoryEventLines(lines), ...(trailingEvent ? [trailingEvent] : [])],
      fileDecoder,
      filePending: trailingEvent ? "" : trailing,
      fileState: fileStateFromStat(stat),
      offset: buffer.length,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], fileState: null, offset: 0 };
    }
    throw error;
  }
}

function readSqliteTrajectorySnapshot(
  source: Extract<TailTrajectorySource, { kind: "sqlite" }>,
): TrajectorySnapshot {
  const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
    agentId: source.agentId,
    sessionId: source.sessionId,
    storePath: source.storePath,
  });
  return {
    events: rows.map((row) => row.event),
    fileState: null,
    maxStorageSeq: rows.at(-1)?.seq ?? -1,
    offset: 0,
  };
}

function readTailSnapshot(selection: TailSelection): TrajectorySnapshot {
  return selection.source.kind === "sqlite"
    ? readSqliteTrajectorySnapshot(selection.source)
    : readTrajectorySnapshot(selection.source.path);
}

function renderEvents(events: TrajectoryEvent[], runtime: RuntimeEnv): TrajectoryCursor | null {
  let cursor: TrajectoryCursor | null = null;
  for (const event of events) {
    runtime.log(formatProgressLine(event));
    cursor = maxCursor(cursor, event);
  }
  return cursor;
}

function fileStateFromStat(stat: fs.Stats): FollowFileState {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  };
}

function sameFileIdentity(left: FollowFileState | null, right: FollowFileState): boolean {
  return Boolean(left && left.dev === right.dev && left.ino === right.ino);
}

function readFollowFileState(filePath: string): FollowFileState | null {
  try {
    return fileStateFromStat(fs.statSync(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function isRunningSession(selection: TailSelection): boolean {
  const cfg = getRuntimeConfig();
  const acpMeta = readAcpSessionMeta({
    sessionKey: resolveStoredSessionKeyForAgentStore({
      cfg,
      agentId: selection.agentId,
      sessionKey: selection.key,
    }),
  });
  return selection.entry.status === "running" || acpMeta?.state === "running";
}

function compareSelectionsByUpdatedAt(a: TailSelection, b: TailSelection): number {
  return (b.entry.updatedAt ?? 0) - (a.entry.updatedAt ?? 0);
}

async function buildTailSelection(params: {
  agentId: string;
  entry: SessionEntry;
  key: string;
  storePath: string;
}): Promise<TailSelection | null> {
  const sessionId = params.entry.sessionId?.trim();
  if (!sessionId) {
    return null;
  }
  return {
    agentId: params.agentId,
    entry: params.entry,
    key: params.key,
    source: {
      agentId: params.agentId,
      kind: "sqlite",
      sessionId,
      storePath: params.storePath,
    },
    storePath: params.storePath,
  };
}

function selectSessionsToTail(selections: TailSelection[], sessionKey?: string): TailSelection[] {
  const requested = sessionKey?.trim();
  if (requested) {
    return selections.filter((selection) => selection.key === requested);
  }

  const running = selections.filter((selection) => isRunningSession(selection));
  if (running.length > 0) {
    // Without an explicit key, prefer all running sessions so follow mode shows
    // concurrent active work instead of only the newest store entry.
    return running.toSorted(compareSelectionsByUpdatedAt);
  }

  const latest = selections.toSorted(compareSelectionsByUpdatedAt)[0];
  return latest ? [latest] : [];
}

function statFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function readNewFileFollowEvents(state: FileFollowState): TrajectoryEvent[] {
  const fileState = readFollowFileState(state.selection.source.path);
  if (!fileState) {
    state.decoder = new StringDecoder("utf8");
    state.fileState = null;
    state.offset = 0;
    state.pending = "";
    return [];
  }

  const replaced = !sameFileIdentity(state.fileState, fileState);
  const truncated = fileState.size < state.offset;
  const possiblyRewrittenSameSize =
    fileState.size === state.offset && state.fileState?.mtimeMs !== fileState.mtimeMs;

  if (replaced || truncated || possiblyRewrittenSameSize) {
    // Log rotation, truncation, and same-size rewrites all require a full
    // rescan; cursor filtering prevents duplicate event output.
    const snapshot = readTrajectorySnapshot(state.selection.source.path);
    state.decoder = snapshot.fileDecoder ?? new StringDecoder("utf8");
    state.fileState = snapshot.fileState;
    state.offset = snapshot.offset;
    state.pending = snapshot.filePending ?? "";
    return eventsAfterCursor(snapshot.events, state.cursor);
  }

  if (fileState.size === state.offset) {
    state.fileState = fileState;
    return [];
  }

  const fd = fs.openSync(state.selection.source.path, "r");
  try {
    const deltaBytes = fileState.size - state.offset;
    if (deltaBytes > TRAJECTORY_RUNTIME_FILE_MAX_BYTES) {
      throw new Error(
        `Trajectory delta exceeds ${TRAJECTORY_RUNTIME_FILE_MAX_BYTES} bytes: ${deltaBytes}`,
      );
    }
    const buffer = Buffer.alloc(deltaBytes);
    const bytesRead = readFileWindowFullySync(fd, buffer, state.offset);
    state.offset += bytesRead;
    state.fileState = fileState;
    const combined = `${state.pending}${state.decoder.write(buffer.subarray(0, bytesRead))}`;
    // Keep an incomplete trailing JSON line until the next poll, matching
    // append-only writers that flush in chunks.
    const lines = combined.split(/\r?\n/u);
    state.pending = lines.pop() ?? "";
    return parseTrajectoryEventLines(lines);
  } finally {
    fs.closeSync(fd);
  }
}

function readNewSqliteFollowEvents(state: SqliteFollowState): TrajectoryEvent[] {
  const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
    agentId: state.selection.source.agentId,
    afterSeq: state.lastStorageSeq,
    sessionId: state.selection.source.sessionId,
    storePath: state.selection.source.storePath,
  });
  if (rows.length === 0) {
    return [];
  }
  state.lastStorageSeq = rows.at(-1)?.seq ?? state.lastStorageSeq;
  return rows.map((row) => row.event);
}

function readNewFollowEvents(state: FollowState): TrajectoryEvent[] {
  return state.kind === "sqlite"
    ? readNewSqliteFollowEvents(state)
    : readNewFileFollowEvents(state);
}

function renderFollowEvents(
  events: TrajectoryEvent[],
  state: FollowState,
  runtime: RuntimeEnv,
): void {
  const cursor = renderEvents(events, runtime);
  if (cursor) {
    state.cursor = maxCursorValue(state.cursor, cursor);
  }
}

async function followSelections(
  selections: TailSelection[],
  runtime: RuntimeEnv,
  initialSnapshots: Map<TailSelection, TrajectorySnapshot>,
): Promise<void> {
  const states = selections.map((selection): FollowState => {
    const snapshot = initialSnapshots.get(selection);
    if (selection.source.kind === "sqlite") {
      return {
        cursor: snapshot ? maxCursorFromEvents(snapshot.events) : null,
        kind: "sqlite",
        lastStorageSeq: snapshot?.maxStorageSeq ?? -1,
        selection: selection as TailSelection & {
          source: Extract<TailTrajectorySource, { kind: "sqlite" }>;
        },
      };
    }
    return {
      cursor: snapshot ? maxCursorFromEvents(snapshot.events) : null,
      decoder: snapshot?.fileDecoder ?? new StringDecoder("utf8"),
      fileState: snapshot?.fileState ?? readFollowFileState(selection.source.path),
      kind: "file",
      offset: snapshot?.offset ?? statFileSize(selection.source.path),
      pending: snapshot?.filePending ?? "",
      selection: selection as TailSelection & {
        source: Extract<TailTrajectorySource, { kind: "file" }>;
      },
    };
  });

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      for (const state of states) {
        try {
          renderFollowEvents(readNewFollowEvents(state), state, runtime);
        } catch (error) {
          runtime.error(
            `Failed to read trajectory progress for ${state.selection.key}: ${formatErrorMessage(
              error,
            )}`,
          );
        }
      }
    }, resolveFollowIntervalMs());

    const stop = () => {
      clearInterval(interval);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function resolveTailTargetAgent(opts: SessionsTailOptions): string | undefined {
  if (opts.agent?.trim() || opts.store?.trim() || opts.allAgents === true) {
    return opts.agent;
  }
  return opts.sessionKey?.trim() ? resolveAgentIdFromSessionKey(opts.sessionKey) : undefined;
}

/** Tails recent trajectory events for the selected session(s). */
export async function sessionsTailCommand(
  opts: SessionsTailOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const tailCount = parseTailCount(opts.tail);
  if (tailCount === null) {
    runtime.error("--tail must be a non-negative integer, for example --tail 25.");
    runtime.exit(1);
    return;
  }

  const cfg = getRuntimeConfig();
  const targets = resolveSessionStoreTargetsOrExit({
    cfg,
    opts: {
      store: opts.store,
      agent: resolveTailTargetAgent(opts),
      allAgents: opts.allAgents,
    },
    runtime,
  });
  if (!targets) {
    return;
  }

  const selections: TailSelection[] = [];
  for (const target of targets) {
    for (const { sessionKey, entry } of listSessionEntriesReadOnly({
      agentId: target.agentId,
      storePath: target.storePath,
    })) {
      const selection = await buildTailSelection({
        agentId: target.agentId,
        entry,
        key: sessionKey,
        storePath: target.storePath,
      });
      if (selection) {
        selections.push(selection);
      }
    }
  }
  const selected = selectSessionsToTail(selections, opts.sessionKey);
  if (selected.length === 0) {
    const suffix = opts.sessionKey ? ` for ${opts.sessionKey}` : "";
    runtime.log(`No sessions found${suffix}.`);
    return;
  }

  const followSnapshots = new Map<TailSelection, TrajectorySnapshot>();
  for (const selection of selected) {
    const snapshot = readTailSnapshot(selection);
    followSnapshots.set(selection, snapshot);
    renderEvents(tailCount > 0 ? snapshot.events.slice(-tailCount) : [], runtime);
  }

  if (opts.follow) {
    await followSelections(selected, runtime, followSnapshots);
  }
}
