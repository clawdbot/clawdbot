import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  projectAgentHarnessTranscriptMessageForDisplay,
  runAgentHarnessBeforeMessageWriteHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  publishSessionTranscriptUpdateByIdentity,
  type SessionTranscriptTargetParams,
  type SessionTranscriptWriteLockParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import type { AttemptParamsLike } from "./attempt-types.js";

type TranscriptMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;
type AppendResult =
  | { appended: boolean; message: TranscriptMessage; messageId: string }
  | undefined;
type PendingWrite = { eventId?: string; message: TranscriptMessage };
type ToolGroup = { order: string[]; results: Map<string, PendingWrite> };

export type AttemptTranscriptJournal = ReturnType<typeof createAttemptTranscriptJournal>;

export function projectCopilotAttemptMessagesForVisibility(
  attempt: AttemptParamsLike,
  messages: AgentMessage[],
): AgentMessage[] {
  const snapshot = [...messages];
  const lastIndex = snapshot.length - 1;
  const prompt = readString(attempt.transcriptPrompt) ?? readString(attempt.prompt);
  const current =
    attempt.userTurnTranscriptRecorder?.message ??
    (prompt
      ? ({ role: "user", content: prompt, timestamp: Date.now() } as Extract<
          AgentMessage,
          { role: "user" }
        >)
      : undefined);
  if (!current) {
    return snapshot;
  }
  const currentMessage = projectAgentHarnessTranscriptMessageForDisplay({
    hidden: attempt.trigger === "memory",
    message: current,
  });
  if (isSameUserTurn(snapshot[lastIndex], current)) {
    snapshot[lastIndex] = currentMessage;
  } else {
    snapshot.push(currentMessage);
  }
  return snapshot;
}

export function createAttemptTranscriptJournal(params: {
  abortSession: () => Promise<void>;
  attempt: AttemptParamsLike;
  messages: AgentMessage[];
  sdkSessionId: string;
}) {
  const hiddenTurn = params.attempt.trigger === "memory";
  const messagesSnapshot = projectCopilotAttemptMessagesForVisibility(
    params.attempt,
    params.messages,
  );
  const target = resolveTranscriptTarget(params.attempt);
  const config = params.attempt.config as SessionTranscriptWriteLockParams["config"];
  const seenEventIds = new Set<string>();
  const suppressedToolCallIds = new Set<string>();
  const deferredUserWrites: PendingWrite[] = [];
  let pendingTools: ToolGroup | undefined;
  let queue = Promise.resolve();
  let firstFailure: Error | undefined;
  let abortPromise: Promise<void> | undefined;
  let replayInvalid = false;
  let initialSdkUserObserved = false;
  let latestAssistantKey: string | undefined;
  let assistantTranscriptOwned = false;
  let assistantTranscriptIdempotencyKey: string | undefined;

  const captureFailure = (error: unknown) => {
    if (firstFailure) {
      return;
    }
    firstFailure = error instanceof Error ? error : new Error(String(error));
    replayInvalid = true;
    abortPromise = params.abortSession().catch(() => undefined);
  };

  const schedule = (task: () => Promise<void> | void) => {
    if (firstFailure) {
      return;
    }
    // The SDK does not await event callbacks: its checkpoint can advance before this queue.
    // Maintainers accept that crash window; an acknowledged upstream sink is separate work.
    const run = async () => {
      if (!firstFailure) {
        await task();
      }
    };
    queue = queue.then(run, run).catch(captureFailure);
  };

  const append = async (
    write: PendingWrite,
  ): Promise<{ blocked: boolean; result: AppendResult }> => {
    let blocked = false;
    const result = (await appendSessionTranscriptMessageByIdentity({
      ...target,
      ...(config ? { config } : {}),
      ...(write.eventId ? { eventId: write.eventId } : {}),
      idempotencyLookup: "scan",
      message: write.message,
      prepareMessageAfterIdempotencyCheck: (message) => {
        const hooked = runAgentHarnessBeforeMessageWriteHook({
          message,
          agentId: target.agentId,
          sessionKey: target.sessionKey,
        });
        if (!hooked) {
          blocked = true;
          return undefined;
        }
        const idempotencyKey = (message as { idempotencyKey?: string }).idempotencyKey;
        const toolIdentity =
          message.role === "toolResult"
            ? { toolCallId: message.toolCallId, toolName: message.toolName }
            : {};
        return projectAgentHarnessTranscriptMessageForDisplay({
          hidden: hiddenTurn || (message as { display?: boolean }).display === false,
          message: {
            ...hooked,
            ...toolIdentity,
            ...(idempotencyKey ? { idempotencyKey } : {}),
          },
        }) as TranscriptMessage;
      },
    })) as AppendResult;
    return { blocked, result };
  };

  const publish = async (appended: boolean) => {
    if (!appended) {
      return;
    }
    await publishSessionTranscriptUpdateByIdentity({ ...target }).catch((error) => {
      console.warn("[copilot-attempt] transcript update notification failed", error);
    });
  };

  const accept = (result: AppendResult): boolean => {
    if (!result) {
      return false;
    }
    messagesSnapshot.push(result.message);
    return result.appended;
  };

  const barrier = async (boundary: string) => {
    await queue;
    if (!firstFailure && pendingTools) {
      captureFailure(
        new Error(
          `Copilot transcript reached ${boundary} with unresolved tool results: ${pendingTools.order.join(", ")}`,
        ),
      );
    }
    await abortPromise;
    if (firstFailure) {
      const error = new Error(
        `[copilot-attempt] canonical transcript persistence failed: ${firstFailure.message}`,
        { cause: firstFailure },
      ) as Error & { code?: string };
      error.code = "transcript_persistence_failed";
      throw error;
    }
  };

  return {
    async persistInitialUser() {
      const recorder = params.attempt.userTurnTranscriptRecorder;
      if (!recorder) {
        captureFailure(new Error("Copilot transcript requires a user-turn recorder"));
        return await barrier("user prompt");
      }
      if (recorder.isBlocked()) {
        dropCurrentTailUser(messagesSnapshot, recorder.message);
        return;
      }
      const persistence = Promise.resolve().then(async () => {
        // resolveMessage prepares input/media only; this journal's append callback is the
        // sole before_message_write policy decision for the runtime-owned user row.
        const resolved = await recorder.resolveMessage();
        if (!resolved) {
          throw new Error("Copilot transcript user turn resolved without a message");
        }
        const outcome = await append({
          message: {
            ...resolved,
            idempotencyKey: `${params.attempt.runId}:user`,
          } as TranscriptMessage,
        });
        if (isSameUserTurn(messagesSnapshot.at(-1), resolved)) {
          messagesSnapshot.pop();
        }
        if (!outcome.result) {
          recorder.markBlocked();
          return;
        }
        const persisted = outcome.result.message as Extract<AgentMessage, { role: "user" }>;
        accept(outcome.result);
        recorder.markRuntimePersisted(persisted);
        params.attempt.onUserMessagePersisted?.(persisted);
        await publish(outcome.result.appended);
      });
      recorder.markRuntimePersistencePending(persistence);
      await persistence.catch(captureFailure);
      await barrier("user prompt");
    },
    recordSdkUser(input: {
      eventId: string;
      message: Extract<AgentMessage, { role: "user" }>;
      autopilotContinuation: boolean;
      replayIncomplete?: boolean;
    }) {
      if (firstFailure || seenEventIds.has(input.eventId)) {
        return;
      }
      seenEventIds.add(input.eventId);
      replayInvalid ||= input.replayIncomplete === true;
      if (!initialSdkUserObserved && !input.autopilotContinuation) {
        initialSdkUserObserved = true;
        return;
      }
      initialSdkUserObserved = true;
      schedule(async () => {
        const write = { eventId: input.eventId, message: input.message };
        if (pendingTools) {
          deferredUserWrites.push(write);
          return;
        }
        const outcome = await append(write);
        await publish(accept(outcome.result));
      });
    },
    recordAssistant(input: {
      eventId: string;
      message: Extract<AgentMessage, { role: "assistant" }>;
      toolCallIds: string[];
    }) {
      if (firstFailure || seenEventIds.has(input.eventId)) {
        return;
      }
      seenEventIds.add(input.eventId);
      const key = `copilot-sdk:${params.sdkSessionId}:${input.eventId}`;
      latestAssistantKey = key;
      assistantTranscriptOwned = false;
      assistantTranscriptIdempotencyKey = undefined;
      schedule(async () => {
        if (pendingTools) {
          throw new Error("Copilot emitted an assistant message before tool results settled");
        }
        const outcome = await append({
          eventId: input.eventId,
          message: { ...input.message, idempotencyKey: key } as TranscriptMessage,
        });
        if (latestAssistantKey === key) {
          assistantTranscriptOwned = true;
          assistantTranscriptIdempotencyKey = outcome.result ? key : undefined;
        }
        const persistedIds = outcome.result ? readAssistantToolCallIds(outcome.result.message) : [];
        for (const toolCallId of input.toolCallIds) {
          if (!persistedIds.includes(toolCallId)) {
            suppressedToolCallIds.add(toolCallId);
          }
        }
        if (persistedIds.length > 0) {
          pendingTools = { order: persistedIds, results: new Map() };
        }
        await publish(accept(outcome.result));
      });
    },
    recordToolResult(input: {
      eventId: string;
      message: Extract<AgentMessage, { role: "toolResult" }>;
      replayIncomplete?: boolean;
    }) {
      if (firstFailure || seenEventIds.has(input.eventId)) {
        return;
      }
      seenEventIds.add(input.eventId);
      schedule(async () => {
        if (suppressedToolCallIds.has(input.message.toolCallId)) {
          return;
        }
        const group = pendingTools;
        if (!group || !group.order.includes(input.message.toolCallId)) {
          throw new Error(`Copilot emitted an unmatched tool result: ${input.message.toolCallId}`);
        }
        group.results.set(input.message.toolCallId, {
          eventId: input.eventId,
          message: {
            ...input.message,
            idempotencyKey: `copilot-sdk:${params.sdkSessionId}:${input.eventId}`,
          } as TranscriptMessage,
        });
        replayInvalid ||= input.replayIncomplete === true;
        if (!group.order.every((toolCallId) => group.results.has(toolCallId))) {
          return;
        }
        let appended = false;
        for (const toolCallId of group.order) {
          const write = group.results.get(toolCallId);
          if (!write) {
            throw new Error(`Copilot transcript lost tool result: ${toolCallId}`);
          }
          const outcome = await append(write);
          if (outcome.blocked || outcome.result?.message.role !== "toolResult") {
            // Policy omission remains authoritative, but the native checkpoint cannot be resumed
            // across a structurally incomplete application transcript.
            replayInvalid = true;
          }
          const didAppend = accept(outcome.result);
          appended ||= didAppend;
        }
        pendingTools = undefined;
        for (const write of deferredUserWrites.splice(0)) {
          const outcome = await append(write);
          const didAppend = accept(outcome.result);
          appended ||= didAppend;
        }
        await publish(appended);
      });
    },
    failIfPendingTools(boundary: string) {
      schedule(() => {
        if (pendingTools) {
          throw new Error(
            `Copilot transcript reached ${boundary} with unresolved tool results: ${pendingTools.order.join(", ")}`,
          );
        }
      });
    },
    barrier,
    hasFailed: () => firstFailure !== undefined,
    snapshot: () => ({
      assistantTranscriptOwned,
      assistantTranscriptIdempotencyKey,
      messagesSnapshot: [...messagesSnapshot],
      replayInvalid,
    }),
  };
}

function resolveTranscriptTarget(attempt: AttemptParamsLike): SessionTranscriptTargetParams {
  const sessionId = readString(attempt.sessionTarget?.sessionId);
  const sessionKey = readString(attempt.sessionTarget?.sessionKey);
  const storePath = readString(attempt.sessionTarget?.storePath);
  if (!sessionId || !sessionKey || !storePath) {
    const error = new Error(
      "[copilot-attempt] canonical transcript persistence requires an exact runtime session target",
    ) as Error & { code?: string };
    error.code = "transcript_persistence_failed";
    throw error;
  }
  const agentId = readString(attempt.sessionTarget?.agentId ?? attempt.agentId);
  return { sessionId, sessionKey, storePath, ...(agentId ? { agentId } : {}) };
}

function readAssistantToolCallIds(message: TranscriptMessage): string[] {
  return message.role === "assistant"
    ? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
    : [];
}

function dropCurrentTailUser(
  messages: AgentMessage[],
  current: Extract<AgentMessage, { role: "user" }> | undefined,
): void {
  if (isSameUserTurn(messages.at(-1), current)) {
    messages.pop();
  }
}

function isSameUserTurn(
  candidate: AgentMessage | undefined,
  current: Extract<AgentMessage, { role: "user" }> | undefined,
): boolean {
  if (!candidate || candidate.role !== "user" || !current) {
    return false;
  }
  if (candidate === current) {
    return true;
  }
  const candidateKey = (candidate as { idempotencyKey?: unknown }).idempotencyKey;
  const currentKey = (current as { idempotencyKey?: unknown }).idempotencyKey;
  if (typeof candidateKey === "string" || typeof currentKey === "string") {
    return (
      typeof candidateKey === "string" &&
      typeof currentKey === "string" &&
      candidateKey === currentKey
    );
  }
  const candidateText = readUserText(candidate.content);
  const currentText = readUserText(current.content);
  if (candidateText !== undefined || currentText !== undefined) {
    return candidateText === currentText;
  }
  return JSON.stringify(candidate.content) === JSON.stringify(current.content);
}

function readUserText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  if (content.length !== 1) {
    return undefined;
  }
  const part = content[0];
  const text =
    part && typeof part === "object" && (part as { type?: unknown }).type === "text"
      ? (part as { text?: unknown }).text
      : undefined;
  return typeof text === "string" ? text : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
