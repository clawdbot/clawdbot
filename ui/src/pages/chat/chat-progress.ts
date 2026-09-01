import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import type { ChatGuardianNotice, ChatItem, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { formatCompactTokenCount } from "../../lib/format.ts";
import type { RunOutputUsage } from "./tool-stream-contract.ts";

type WorkingProgress = {
  key: string;
  runId: string | null;
  startedAt: number;
};

type WorkingProgressCache = WorkingProgress;

const CONTEXT_COMPACTION_CUSTOM_TYPE = "openclaw.context-compaction";

export function isContextCompactionActivity(message: unknown): boolean {
  return asRecord(asRecord(message)?.["__openclaw"])?.runtimeActivityKind === "context_compaction";
}

export function projectContextCompactionActivity(message: unknown): unknown {
  const record = asRecord(message);
  if (record?.role !== "custom" || record.customType !== CONTEXT_COMPACTION_CUSTOM_TYPE) {
    return message;
  }
  const metadata = asRecord(record["__openclaw"]);
  const details = asRecord(record.details);
  const { idempotencyKey: _activityId, ...activity } = record;
  return {
    ...activity,
    role: "assistant",
    content: [{ type: "text", text: t("chat.composer.contextCompacted") }],
    ...(typeof metadata?.runId === "string"
      ? { runId: metadata.runId }
      : typeof details?.runId === "string"
        ? { runId: details.runId }
        : {}),
    __openclaw: {
      ...metadata,
      runtimeActivityKind: "context_compaction",
    },
  };
}

const workingProgressBySession = new Map<string, WorkingProgressCache>();
let anonymousWorkingProgressId = 0;

export function buildGuardianNoticeItem(
  notice: ChatGuardianNotice,
): Extract<ChatItem, { kind: "notice" }> {
  const action = notice.command ?? t("chat.systemNotice.guardian.requestedAction");
  if (notice.source === "system") {
    return {
      kind: "notice",
      key: notice.key,
      icon: "cpu",
      label: t("common.system"),
      text: notice.message ?? "",
      timestamp: notice.timestamp,
    };
  }
  if (notice.kind === "approved") {
    return {
      kind: "notice",
      key: notice.key,
      icon: "shieldCheck",
      label: t("chat.systemNotice.guardian.approvedSummary", { action }),
      text: "",
      timestamp: notice.timestamp,
    };
  }
  if (notice.kind === "warning") {
    return {
      kind: "notice",
      key: notice.key,
      icon: "shieldCheck",
      label: t("chat.systemNotice.guardian.warningLabel"),
      text: notice.message ?? t("chat.systemNotice.guardian.warningFallback"),
      timestamp: notice.timestamp,
      tone: "danger",
    };
  }
  if (notice.kind === "reviewing" || notice.kind === "strict-review-required") {
    return {
      kind: "notice",
      key: notice.key,
      icon: "shieldCheck",
      label: t("chat.systemNotice.guardian.strictReviewRequiredLabel"),
      text: t("chat.systemNotice.guardian.strictReviewRequiredSummary"),
      timestamp: notice.timestamp,
      tone: "danger",
    };
  }
  return {
    kind: "notice",
    key: notice.key,
    icon: "shieldCheck",
    label: t("chat.systemNotice.guardian.deniedLabel"),
    text: t("chat.systemNotice.guardian.deniedSummary", {
      action,
      risk: notice.riskLevel ?? t("chat.systemNotice.guardian.unknownRisk"),
      rationale: notice.rationale ?? t("chat.systemNotice.guardian.noRationale"),
    }),
    timestamp: notice.timestamp,
    tone: "danger",
  };
}

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

function queuedSendStarted(item: ChatQueueItem): boolean {
  return typeof item.sendSubmittedAtMs === "number" || (item.sendAttempts ?? 0) > 0;
}

export function isQueuedSendInlineState(item: ChatQueueItem): boolean {
  return (
    queuedSendStarted(item) &&
    !item.localCommandName &&
    (item.sendState === "failed" ||
      item.sendState === "unconfirmed" ||
      (item.sendState === "waiting-idle" && Boolean(item.sendError)))
  );
}

export function shouldRenderQueuedSendInThread(item: ChatQueueItem): boolean {
  // Page-local submit timing is not persisted; durable attempts keep restored prompts visible.
  return (
    queuedSendStarted(item) &&
    (item.sendState === "waiting-model" ||
      item.sendState === "sending" ||
      item.sendState === "waiting-reconnect" ||
      isQueuedSendInlineState(item))
  );
}

export function resolveWorkingProgress(
  sessionKey: string,
  runId: string | null,
  streamStartedAt: number | null,
  queue: ChatQueueItem[],
  streamSegments: Array<{ ts: number; runId?: string }>,
  toolMessages: unknown[],
): WorkingProgress {
  const queuedProgress =
    queue.find((item) => item.sendState === "sending" && shouldRenderQueuedSendInThread(item)) ??
    queue.find(shouldRenderQueuedSendInThread);
  const queuedRunId = queuedProgress?.sendRunId ?? queuedProgress?.pendingRunId;
  const segmentRunId = streamSegments
    .map((segment) => segment.runId)
    .findLast(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
  const toolRunId = toolMessages
    .map((message) => (message as Record<string, unknown> | null)?.runId)
    .findLast(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
  // Stream and tool facts describe work already observed in this row. Queue
  // identity is only a pre-run fallback and must not claim an active tail.
  const explicitRunId = runId ?? segmentRunId ?? toolRunId ?? queuedRunId;
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
  return { key, runId: explicitRunId ?? compatibleCached?.runId ?? null, startedAt };
}

export function clearWorkingProgress(sessionKey: string): void {
  workingProgressBySession.delete(sessionKey);
}

export function resetWorkingProgress(): void {
  workingProgressBySession.clear();
  anonymousWorkingProgressId = 0;
}

export type TurnRecap = { runtimeMs: number; outputTokens: number | null };

// The pane owns one watched run. Session-wide usage is a different fact and
// may still describe the previous response when the terminal row arrives.
export type TurnRecapWatch = {
  sessionKey: string;
  agentId: string | null;
  gatewayClient: GatewayBrowserClient | null;
  runId: string;
  recap: TurnRecap | null;
};

export function resolveTurnRecap(
  host: { turnRecapWatch: TurnRecapWatch | null },
  params: {
    sessionKey: string;
    agentId?: string | null;
    gatewayClient?: GatewayBrowserClient | null;
    indicator?: { runId?: string };
    row?: Pick<GatewaySessionRow, "lastRunId" | "status" | "runtimeMs">;
    usageByRun?: ReadonlyMap<string, RunOutputUsage>;
  },
): (TurnRecap & { runId: string }) | null {
  const { sessionKey, agentId = null, gatewayClient = null, indicator, row, usageByRun } = params;
  let watch = host.turnRecapWatch;
  if (
    watch?.sessionKey !== sessionKey ||
    watch.agentId !== agentId ||
    watch.gatewayClient !== gatewayClient
  ) {
    watch = null;
  }
  if (indicator) {
    const runId = indicator.runId;
    if (!runId) {
      host.turnRecapWatch = null;
      return null;
    }
    if (watch?.runId !== runId) {
      watch = { sessionKey, agentId, gatewayClient, runId, recap: null };
    }
  }
  host.turnRecapWatch = watch;
  if (!watch) {
    return null;
  }
  const outputTokens =
    usageByRun?.get(watch.runId)?.outputTokens ?? watch.recap?.outputTokens ?? null;
  if (row?.lastRunId === watch.runId) {
    const runtimeMs = row.runtimeMs;
    if (row.status === "done" && typeof runtimeMs === "number" && Number.isFinite(runtimeMs)) {
      watch.recap = { runtimeMs, outputTokens };
    } else if (row.status && row.status !== "done") {
      watch.recap = null;
    }
  }
  // Usage can arrive after terminal presentation. Keep accepting facts for
  // this exact run without borrowing another run's session-row counters.
  if (watch.recap && watch.recap.outputTokens !== outputTokens) {
    watch.recap = { ...watch.recap, outputTokens };
  }
  return indicator || !watch.recap ? null : { ...watch.recap, runId: watch.runId };
}
