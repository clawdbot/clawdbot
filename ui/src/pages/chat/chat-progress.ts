import { t } from "../../i18n/index.ts";
import type { ChatItem, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { formatCompactTokenCount } from "../../lib/format.ts";

const workingStartBySession = new Map<string, { runId: string | null; startedAt: number }>();

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

export function resolveWorkingStartedAt(
  sessionKey: string,
  runId: string | null,
  streamStartedAt: number | null,
  queue: ChatQueueItem[],
  streamSegments: Array<{ ts: number }>,
  toolMessages: unknown[],
): number {
  const queuedRunId =
    queue.find((item) => item.sendState === "sending" && shouldRenderQueuedSendInThread(item))
      ?.sendRunId ?? queue.find(shouldRenderQueuedSendInThread)?.sendRunId;
  const toolRunId = toolMessages
    .map((message) => (message as Record<string, unknown> | null)?.runId)
    .find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
  const explicitRunId = queuedRunId ?? runId ?? toolRunId;
  const cached = workingStartBySession.get(sessionKey);
  const cachedStartedAt =
    cached && (!explicitRunId || !cached.runId || cached.runId === explicitRunId)
      ? cached.startedAt
      : null;
  const candidates = [
    cachedStartedAt,
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
  workingStartBySession.set(sessionKey, {
    runId: explicitRunId ?? cached?.runId ?? null,
    startedAt,
  });
  return startedAt;
}

export function clearWorkingStartedAt(sessionKey: string): void {
  workingStartBySession.delete(sessionKey);
}

export function resetWorkingStartedAt(): void {
  workingStartBySession.clear();
}
