/**
 * Session trajectory tail command.
 *
 * It selects active or requested sessions, renders recent trajectory events,
 * and can follow append-only trajectory files across rotation/truncation.
 */
import fs from "node:fs";
import path from "node:path";
import { readAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions.js";
import { resolveSessionFilePath } from "../config/sessions/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveStoredSessionKeyForAgentStore } from "../gateway/session-store-key.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveTrajectoryFilePath } from "../trajectory/paths.js";
import { resolveTrajectoryRuntimeFile } from "../trajectory/runtime-file.js";
import type { TrajectoryEvent } from "../trajectory/types.js";
import {
  ensureExplicitSessionStoreMigratedForCommand,
  ensureSessionStateMigratedForCommand,
} from "./session-state-migration.js";
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
  trajectoryPath: string;
};

type FollowState = {
  cursor: TrajectoryCursor | null;
  fileState: FollowFileState | null;
  offset: number;
  pending: string;
  selection: TailSelection;
};

type TrajectorySnapshot = {
  events: TrajectoryEvent[];
  fileState: FollowFileState | null;
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
export function setSessionsTailFollowIntervalMsForTests(intervalMs?: number): void {
  followIntervalMsForTests = intervalMs;
}

function resolveFollowIntervalMs(): number {
  return followIntervalMsForTests ?? FOLLOW_INTERVAL_MS;
}

function parseTailCount(value: string | number | undefined): number | null {
  if (value === undefined) {
    return DEFAULT_TAIL_COUNT;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  return Number.parseInt(trimmed, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    const stat = fs.statSync(filePath);
    const text = fs.readFileSync(filePath, "utf8");
    return {
      events: parseTrajectoryEventLines(text.split(/\r?\n/u)),
      fileState: fileStateFromStat(stat),
      offset: Buffer.byteLength(text, "utf8"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], fileState: null, offset: 0 };
    }
    throw error;
  }
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
}): Promise<TailSelection> {
  const sessionsDir = path.dirname(params.storePath);
  const sessionFile = resolveSessionFilePath(params.entry.sessionId, params.entry, {
    agentId: params.agentId,
    sessionsDir,
  });
  const trajectoryPath =
    (await resolveTrajectoryRuntimeFile({
      sessionFile,
      sessionId: params.entry.sessionId,
    })) ??
    resolveTrajectoryFilePath({
      sessionFile,
      sessionId: params.entry.sessionId,
    });
  return {
    agentId: params.agentId,
    entry: params.entry,
    key: params.key,
    storePath: params.storePath,
    trajectoryPath,
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

function readNewFollowEvents(state: FollowState): TrajectoryEvent[] {
  const fileState = readFollowFileState(state.selection.trajectoryPath);
  if (!fileState) {
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
    const snapshot = readTrajectorySnapshot(state.selection.trajectoryPath);
    state.fileState = snapshot.fileState;
    state.offset = snapshot.offset;
    state.pending = "";
    return eventsAfterCursor(snapshot.events, state.cursor);
  }

  if (fileState.size === state.offset) {
    state.fileState = fileState;
    return [];
  }

  const fd = fs.openSync(state.selection.trajectoryPath, "r");
  try {
    const buffer = Buffer.alloc(fileState.size - state.offset);
    fs.readSync(fd, buffer, 0, buffer.length, state.offset);
    state.offset = fileState.size;
    state.fileState = fileState;
    const combined = `${state.pending}${buffer.toString("utf8")}`;
    // Keep an incomplete trailing JSON line until the next poll, matching
    // append-only writers that flush in chunks.
    const lines = combined.split(/\r?\n/u);
    state.pending = lines.pop() ?? "";
    return parseTrajectoryEventLines(lines);
  } finally {
    fs.closeSync(fd);
  }
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
  initialSnapshots: Map<string, TrajectorySnapshot>,
): Promise<void> {
  const states = selections.map((selection): FollowState => {
    const snapshot = initialSnapshots.get(selection.trajectoryPath);
    return {
      cursor: snapshot ? maxCursorFromEvents(snapshot.events) : null,
      fileState: snapshot?.fileState ?? readFollowFileState(selection.trajectoryPath),
      offset: snapshot?.offset ?? statFileSize(selection.trajectoryPath),
      pending: "",
      selection,
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

  await ensureSessionStateMigratedForCommand(cfg);
  for (const target of targets) {
    await ensureExplicitSessionStoreMigratedForCommand(target.storePath, {
      onWarning: (warning) => runtime.error?.(warning),
    });
  }

  const selections: TailSelection[] = [];
  for (const target of targets) {
    const store = loadSessionStore(target.storePath);
    for (const [key, entry] of Object.entries(store)) {
      selections.push(
        await buildTailSelection({
          agentId: target.agentId,
          entry,
          key,
          storePath: target.storePath,
        }),
      );
    }
  }
  const selected = selectSessionsToTail(selections, opts.sessionKey);
  if (selected.length === 0) {
    const suffix = opts.sessionKey ? ` for ${opts.sessionKey}` : "";
    runtime.log(`No sessions found${suffix}.`);
    return;
  }

  const followSnapshots = new Map<string, TrajectorySnapshot>();
  for (const selection of selected) {
    const snapshot = readTrajectorySnapshot(selection.trajectoryPath);
    followSnapshots.set(selection.trajectoryPath, snapshot);
    renderEvents(tailCount > 0 ? snapshot.events.slice(-tailCount) : [], runtime);
  }

  if (opts.follow) {
    await followSelections(selected, runtime, followSnapshots);
  }
}
