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
  anonymousWorkingProgressId = 0;
}
