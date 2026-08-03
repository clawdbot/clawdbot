import { randomUUID } from "node:crypto";
import type { SessionEntry, PendingTranscriptRepairState } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../harness/hook-helpers.js";
import { loadTranscriptAppendRuntime } from "./runtime-loaders.js";
import { persistSessionEntry } from "./session-helpers.js";

const log = createSubsystemLogger("agents/assistant-transcript-repair");

type AssistantTranscriptRepairContext = {
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath: string;
  sessionAgentId: string;
  config: OpenClawConfig;
};

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
} as const;

/** Records a final whose canonical transcript append failed. */
export async function persistAssistantTranscriptRepairRecord(params: {
  context: AssistantTranscriptRepairContext;
  replyText: string;
  provider?: string;
  model?: string;
  runOwnedSessionId: string;
}): Promise<void> {
  const { context, replyText, provider, model, runOwnedSessionId } = params;
  if (!replyText.trim() || !context.sessionStore || !context.sessionKey.trim()) {
    return;
  }
  const now = Date.now();
  const existing = context.sessionStore[context.sessionKey] ?? context.sessionEntry;
  if (!existing) {
    return;
  }
  const nextRepair: PendingTranscriptRepairState = {
    id: randomUUID(),
    text: replyText,
    ...(provider?.trim() ? { provider: provider.trim() } : {}),
    ...(model?.trim() ? { model: model.trim() } : {}),
    createdAt: now,
  };
  try {
    await persistSessionEntry({
      sessionStore: context.sessionStore,
      sessionKey: context.sessionKey,
      storePath: context.storePath,
      initialEntry: existing,
      entry: {
        ...existing,
        pendingTranscriptRepair: [...(existing.pendingTranscriptRepair ?? []), nextRepair],
        updatedAt: now,
      },
      shouldPersist: (current) =>
        current?.sessionId === runOwnedSessionId && current.abortedLastRun !== true,
    });
  } catch (error) {
    log.warn(
      `Failed to persist assistant transcript repair record for ${context.sessionKey}: ${formatErrorMessage(error)}`,
    );
  }
}

/**
 * Restores missing assistant finals before another turn can observe or extend
 * the transcript. Append failures are an admission barrier: continuing would
 * give the model incomplete history and make the eventual append out of order.
 */
export async function repairPendingAssistantTranscriptTurns(params: {
  context: AssistantTranscriptRepairContext;
}): Promise<void> {
  const { context } = params;
  if (!context.sessionStore || !context.sessionKey) {
    return;
  }
  const entry = context.sessionStore[context.sessionKey] ?? context.sessionEntry;
  const backlog = entry?.pendingTranscriptRepair;
  if (!entry || !backlog?.length) {
    return;
  }

  const { appendExactAssistantMessageToSessionTranscript } = await loadTranscriptAppendRuntime();
  const remaining = [...backlog];
  while (remaining.length > 0) {
    const item = remaining[0]!;
    let result: Awaited<ReturnType<typeof appendExactAssistantMessageToSessionTranscript>>;
    try {
      result = await appendExactAssistantMessageToSessionTranscript({
        agentId: context.sessionAgentId,
        sessionKey: context.sessionKey,
        expectedSessionId: entry.sessionId,
        storePath: context.storePath,
        config: context.config,
        updateMode: "file-only",
        idempotencyKey: `transcript-repair:${item.id}`,
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
        message: {
          role: "assistant",
          content: [{ type: "text", text: item.text }],
          api: "cli",
          provider: item.provider ?? "cli",
          model: item.model ?? "default",
          usage: EMPTY_USAGE,
          stopReason: "stop",
          timestamp: item.createdAt,
        },
      });
    } catch (error) {
      log.warn(
        `Assistant transcript repair failed for ${context.sessionKey}: ${formatErrorMessage(error)}`,
      );
      throw new Error("Previous assistant reply is still pending transcript recovery; retry.", {
        cause: error,
      });
    }

    if (!result.ok && result.code !== "blocked") {
      log.warn(`Assistant transcript repair failed for ${context.sessionKey}: ${result.reason}`);
      throw new Error("Previous assistant reply is still pending transcript recovery; retry.");
    }
    remaining.shift();
    if (result.ok) {
      log.info(`Re-appended missing assistant transcript turn for ${context.sessionKey}`);
    } else {
      log.warn(`Dropped blocked assistant transcript repair for ${context.sessionKey}`);
    }
  }

  const current = context.sessionStore[context.sessionKey];
  if (!current || current.sessionId !== entry.sessionId) {
    return;
  }
  try {
    await persistSessionEntry({
      sessionStore: context.sessionStore,
      sessionKey: context.sessionKey,
      storePath: context.storePath,
      initialEntry: current,
      entry: { ...current, pendingTranscriptRepair: undefined, updatedAt: Date.now() },
      shouldPersist: (latest) => latest?.sessionId === entry.sessionId,
    });
  } catch (error) {
    // The exact append key makes a later retry safe after cleanup failure.
    log.warn(
      `Failed to clear assistant transcript repair record for ${context.sessionKey}: ${formatErrorMessage(error)}`,
    );
  }
}
