import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
/**
 * Session trajectory tail command.
 *
 * It selects active or requested sessions, renders recent trajectory events,
 * and can follow newly appended SQLite trajectory rows.
 */
import { normalizeOptionalString as toOptionalString } from "@openclaw/normalization-core/string-coerce";
import { readAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { getRuntimeConfig } from "../config/config.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveStoredSessionKeyForAgentStore } from "../gateway/session-store-key.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
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

type TailTrajectorySource = {
  agentId: string;
  sessionId: string;
  storePath: string;
};

type SqliteFollowState = {
  lastStorageSeq: number;
  selection: TailSelection;
};

type TrajectorySnapshot = {
  events: TrajectoryEvent[];
  maxStorageSeq: number;
};

const DEFAULT_TAIL_COUNT = 80;
const SESSION_KEY_PAD = 30;
const EVENT_TYPE_PAD = 16;
const FOLLOW_INTERVAL_MS = 1_000;

function parseTailCount(value: string | number | undefined): number | null {
  if (value === undefined) {
    return DEFAULT_TAIL_COUNT;
  }
  return parseStrictNonNegativeInteger(value) ?? null;
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

function readSqliteTrajectorySnapshot(
  source: TailTrajectorySource,
  tailEvents: number,
): TrajectorySnapshot {
  const rows = loadSqliteTrajectoryRuntimeEventRowsSync({
    agentId: source.agentId,
    sessionId: source.sessionId,
    storePath: source.storePath,
    tailEvents,
  });
  return {
    events: rows.map((row) => row.event),
    maxStorageSeq: rows.at(-1)?.seq ?? -1,
  };
}

function readTailSnapshot(selection: TailSelection, tailEvents: number): TrajectorySnapshot {
  return readSqliteTrajectorySnapshot(selection.source, tailEvents);
}

function renderEvents(events: TrajectoryEvent[], runtime: RuntimeEnv): void {
  for (const event of events) {
    runtime.log(formatProgressLine(event));
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

function buildTailSelection(params: {
  agentId: string;
  entry: SessionEntry;
  key: string;
  storePath: string;
}): TailSelection | null {
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

async function followSelections(
  selections: TailSelection[],
  runtime: RuntimeEnv,
  initialSnapshots: Map<TailSelection, TrajectorySnapshot>,
): Promise<void> {
  const states = selections.map((selection): SqliteFollowState => {
    const snapshot = initialSnapshots.get(selection);
    return {
      lastStorageSeq: snapshot?.maxStorageSeq ?? -1,
      selection,
    };
  });

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      for (const state of states) {
        try {
          renderEvents(readNewSqliteFollowEvents(state), runtime);
        } catch (error) {
          runtime.error(
            `Failed to read trajectory progress for ${state.selection.key}: ${formatErrorMessage(
              error,
            )}`,
          );
        }
      }
    }, FOLLOW_INTERVAL_MS);

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
      const selection = buildTailSelection({
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
    const snapshot = readTailSnapshot(selection, Math.max(tailCount, opts.follow ? 1 : 0));
    followSnapshots.set(selection, snapshot);
    renderEvents(tailCount > 0 ? snapshot.events.slice(-tailCount) : [], runtime);
  }

  if (opts.follow) {
    await followSelections(selected, runtime, followSnapshots);
  }
}
