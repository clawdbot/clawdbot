import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { t } from "../../i18n/index.ts";
import type { ChatItem, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { formatCompactTokenCount } from "../../lib/format.ts";

type WorkingProgress = {
  key: string;
  startedAt: number;
};

type WorkingProgressCache = WorkingProgress & {
  runId: string | null;
};

const CONTEXT_COMPACTION_CUSTOM_TYPE = "openclaw.context-compaction";

export function projectContextCompactionActivity(message: unknown): unknown {
  const record = asRecord(message);
  if (record?.role !== "custom" || record.customType !== CONTEXT_COMPACTION_CUSTOM_TYPE) {
    return message;
  }
  const metadata = asRecord(record["__openclaw"]);
  return {
    ...record,
    role: "assistant",
    content: [{ type: "text", text: t("chat.composer.contextCompacted") }],
    __openclaw: {
      ...metadata,
      runtimeActivityKind: "context_compaction",
    },
  };
}

const workingProgressBySession = new Map<string, WorkingProgressCache>();
let anonymousWorkingProgressId = 0;

export function buildCompactionDividerItem(
  marker: Record<string, unknown>,
  timestamp: number,
  index: number,
): Extract<ChatItem, { kind: "divider" }> {
  const tokensBefore = marker.tokensBefore;
  const tokensAfter = marker.tokensAfter;
  const tokensSaved =
    typeof tokensBefore === "number" &&
    Number.isFinite(tokensBefore) &&
    typeof tokensAfter === "number" &&
    Number.isFinite(tokensAfter) &&
    tokensBefore > tokensAfter
      ? Math.floor(tokensBefore - tokensAfter)
      : null;
  return {
    kind: "divider",
    key:
      typeof marker.id === "string"
        ? `divider:compaction:${marker.id}`
        : `divider:compaction:${timestamp}:${index}`,
    label: t("chat.compaction.label"),
    icon: "foldVertical",
    ...(tokensSaved === null
      ? {}
      : {
          metric: t("chat.compaction.savedTokens", {
            count: formatCompactTokenCount(tokensSaved),
          }),
        }),
    description: t("chat.compaction.description"),
    action: { kind: "session-checkpoints", label: t("chat.compaction.openCheckpoints") },
    timestamp,
  };
}

export function buildResetDividerItem(
  marker: Record<string, unknown>,
  timestamp: number,
  index: number,
): Extract<ChatItem, { kind: "divider" }> {
  return {
    kind: "divider",
    key:
      typeof marker.id === "string"
        ? `divider:reset:${marker.id}`
        : `divider:reset:${timestamp}:${index}`,
    label: t("chat.sessionReset.label"),
    icon: "rotateCcw",
    description: t("chat.sessionReset.description"),
    timestamp,
  };
}

export function shouldRenderQueuedSendInThread(item: ChatQueueItem): boolean {
  // Page-local submit timing is not persisted; durable attempts keep restored prompts visible.
  const sendStarted = typeof item.sendSubmittedAtMs === "number" || (item.sendAttempts ?? 0) > 0;
  return (
    sendStarted &&
    (item.sendState === "waiting-model" ||
      item.sendState === "sending" ||
      item.sendState === "waiting-reconnect")
  );
}

export function resolveWorkingProgress(
  sessionKey: string,
  runId: string | null,
  streamStartedAt: number | null,
  queue: ChatQueueItem[],
  streamSegments: Array<{ ts: number }>,
  toolMessages: unknown[],
): WorkingProgress {
  const queuedRunId =
    queue.find((item) => item.sendState === "sending" && shouldRenderQueuedSendInThread(item))
      ?.sendRunId ?? queue.find(shouldRenderQueuedSendInThread)?.sendRunId;
  const toolRunId = toolMessages
    .map((message) => (message as Record<string, unknown> | null)?.runId)
    .find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
  const explicitRunId = queuedRunId ?? runId ?? toolRunId;
  const cached = workingProgressBySession.get(sessionKey);
  const compatibleCached =
    cached && (!explicitRunId || !cached.runId || cached.runId === explicitRunId) ? cached : null;
  const candidates = [
    compatibleCached?.startedAt,
    streamStartedAt,
    ...queue
      .filter(shouldRenderQueuedSendInThread)
      // Send performance fields use performance.now(); the elapsed timer renders against Date.now().
      .map((item) => item.createdAt),
    ...streamSegments.map((segment) => segment.ts),
    ...toolMessages.map((message) => {
      const receivedAt = (message as Record<string, unknown> | null)?.[
        "__openclawToolStreamReceivedAt"
      ];
      return typeof receivedAt === "number" ? receivedAt : null;
    }),
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const startedAt = candidates.length > 0 ? Math.min(...candidates) : Date.now();
  const key =
    compatibleCached?.key ??
    `stream-working:${JSON.stringify([
      sessionKey,
      explicitRunId ?? `anonymous-${++anonymousWorkingProgressId}`,
    ])}`;
  workingProgressBySession.set(sessionKey, {
    key,
    runId: explicitRunId ?? compatibleCached?.runId ?? null,
    startedAt,
  });
  return { key, startedAt };
}

export function clearWorkingProgress(sessionKey: string): void {
  workingProgressBySession.delete(sessionKey);
}

export function resetWorkingProgress(): void {
  workingProgressBySession.clear();
  turnRecapWatchBySession.clear();
  anonymousWorkingProgressId = 0;
}

export type TurnRecap = { runtimeMs: number; outputTokens: number | null };

/** `baselineEndedAt` is the session row's endedAt when the working indicator
 * appeared — i.e. the PREVIOUS run's terminal stamp (or null once the run
 * start patch cleared it). Only a row whose endedAt moved past the baseline
 * belongs to the run this pane just watched; timestamps never correlate
 * reliably because consecutive turns can be seconds apart. `settled` freezes
 * the first resolved recap so later terminal rows from runs this pane never
 * watched (background/cron/other devices) cannot rewrite the displayed row. */
type TurnRecapWatch = {
  watching: boolean;
  /** False while no session row was observed during the watch: with no
   * baseline, a later row's stamp cannot be told apart from the previous
   * run's, so such a watch is consumed unresolved at settle. */
  baselineKnown: boolean;
  baselineEndedAt: number | null;
  /** The previous run's persisted token count. The terminal stamp and the
   * usage persist are separate gateway writes, so a fresh-endedAt row can
   * still carry the PREVIOUS turn's outputTokens; an unchanged value at
   * resolve is treated as that lag, not this turn's count. */
  baselineOutputTokens: number | null;
  /** Highest live usage-stream counter observed for the watched run. Fills
   * in when the row's outputTokens hasn't been rewritten yet (see above);
   * attributed by chatRunId upstream, so it cannot be another run's. */
  liveOutputTokens: number | null;
  /** A terminal stamp changed while the claw was still up: some run's
   * terminal (this one's early, or an interleaved older patch) already
   * passed, so settle cannot attribute later stamps and must consume the
   * watch. Without a run identity on session rows, every anomalous
   * interleaving fails quiet instead of risking a wrong recap. */
  absorbedTerminal: boolean;
  /** First idle render after the indicator cleared; the watch expires a
   * short window later so a canceled queued send (indicator shown, run
   * never started) cannot hand its watch to a much-later background/cron
   * completion. */
  settleStartedAt: number | null;
  settled: TurnRecap | null;
};

/** The watched run's terminal patch lands within moments of the indicator
 * clearing; anything arriving after this window is another run's. Accepted
 * residual: session rows carry no run identity, so an unrelated same-session
 * completion INSIDE this window (e.g. after a canceled queued send) can be
 * shown as the watched turn's recap. Closing that needs a terminal-row run
 * id from the gateway; until then the row is cosmetic and self-corrects on
 * the next turn. */
const TURN_RECAP_SETTLE_WINDOW_MS = 30_000;

const turnRecapWatchBySession = new Map<string, TurnRecapWatch>();

type TurnRecapSessionRow = {
  status?: string;
  endedAt?: number;
  runtimeMs?: number;
  outputTokens?: number;
};

function rowOutputTokens(row: TurnRecapSessionRow | undefined): number | null {
  return typeof row?.outputTokens === "number" ? row.outputTokens : null;
}

/** Post-turn recap for the bottom-of-thread status row. While the working
 * indicator is visible the session is "watched" (and any older recap hides);
 * once it settles, the first session row carrying a fresh terminal stamp
 * resolves the recap, which then sticks until the next run. Failed runs stay
 * quiet — the error surfaces own those. */
export function resolveTurnRecap(
  sessionKey: string,
  indicatorVisible: boolean,
  row: TurnRecapSessionRow | undefined,
  liveOutputTokens: number | null = null,
): TurnRecap | null {
  const watch = turnRecapWatchBySession.get(sessionKey);
  const rowEndedAt = typeof row?.endedAt === "number" ? row.endedAt : null;
  if (watch && liveOutputTokens !== null && liveOutputTokens > (watch.liveOutputTokens ?? -1)) {
    // Monotonic max: the usage map entry is dropped at lifecycle end, so the
    // last counter seen while watching/settling is the run's final total.
    watch.liveOutputTokens = liveOutputTokens;
  }
  if (indicatorVisible) {
    if (!watch || !watch.watching) {
      turnRecapWatchBySession.set(sessionKey, {
        watching: true,
        baselineKnown: row !== undefined,
        baselineEndedAt: rowEndedAt,
        baselineOutputTokens: rowOutputTokens(row),
        liveOutputTokens,
        absorbedTerminal: false,
        settleStartedAt: null,
        settled: null,
      });
    } else if (!watch.baselineKnown) {
      if (row !== undefined) {
        watch.baselineKnown = true;
        watch.baselineEndedAt = rowEndedAt;
        watch.baselineOutputTokens = rowOutputTokens(row);
      }
    } else if (rowEndedAt !== null && rowEndedAt !== watch.baselineEndedAt) {
      watch.baselineEndedAt = rowEndedAt;
      watch.absorbedTerminal = true;
    }
    return null;
  }
  if (!watch) {
    return null;
  }
  watch.watching = false;
  if (watch.settled) {
    return watch.settled;
  }
  if (watch.absorbedTerminal || !watch.baselineKnown) {
    // See TurnRecapWatch: attribution is ambiguous, so this turn quietly
    // gets no recap rather than freezing another run's numbers.
    turnRecapWatchBySession.delete(sessionKey);
    return null;
  }
  if (watch.settleStartedAt === null) {
    watch.settleStartedAt = Date.now();
  } else if (Date.now() - watch.settleStartedAt > TURN_RECAP_SETTLE_WINDOW_MS) {
    turnRecapWatchBySession.delete(sessionKey);
    return null;
  }
  const isStale =
    rowEndedAt === null || (watch.baselineEndedAt !== null && rowEndedAt <= watch.baselineEndedAt);
  if (isStale) {
    // No terminal patch for the watched run yet; keep waiting (bounded by
    // the settle window above). Stamps never regress, so <= is stale.
    return null;
  }
  // A fresh terminal always concludes the watch: recap on a clean "done",
  // quiet consume otherwise — waiting past it would let unrelated later
  // completions attach to this turn.
  turnRecapWatchBySession.delete(sessionKey);
  const runtimeMs = row?.runtimeMs;
  if (row?.status !== "done" || typeof runtimeMs !== "number" || !Number.isFinite(runtimeMs)) {
    return null;
  }
  // The terminal stamp and the usage persist are separate gateway writes, so
  // this fresh-endedAt row can still carry the previous turn's outputTokens.
  // An unchanged-from-baseline value is that lag: fall back to the watched
  // run's live counter (or show none) rather than the stale number.
  const rowTokens = rowOutputTokens(row);
  const settled: TurnRecap = {
    runtimeMs,
    outputTokens:
      rowTokens !== null && rowTokens !== watch.baselineOutputTokens
        ? rowTokens
        : watch.liveOutputTokens,
  };
  turnRecapWatchBySession.set(sessionKey, { ...watch, settled });
  return settled;
}
