import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  projectAgentHarnessTranscriptMessageForDisplay,
  runAgentHarnessBeforeMessageWriteHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  appendSessionTranscriptMessagesByIdentity,
  publishSessionTranscriptUpdateByIdentity,
  readVisibleSessionTranscriptMessageEntries,
  type SessionTranscriptTargetParams,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { readString } from "./attempt-config.js";
import type { AttemptParamsLike } from "./attempt-types.js";

type TranscriptMessage = Extract<AgentMessage, { role: "user" | "assistant" | "toolResult" }>;
type AppendResult =
  | { appended: boolean; message: TranscriptMessage; messageId: string }
  | undefined;
type PendingWrite = { eventId?: string; message: TranscriptMessage };
type ToolGroup = {
  assistant: PendingWrite;
  assistantKey: string;
  order: string[];
  results: Map<string, PendingWrite>;
};

export type AttemptTranscriptJournal = ReturnType<typeof createAttemptTranscriptJournal>;

export function createAttemptTranscriptJournal(params: {
  abortSession: () => Promise<void>;
  attempt: AttemptParamsLike;
  messages: AgentMessage[];
  sdkSessionId: string;
}) {
  const hiddenTurn = params.attempt.trigger === "memory";
  const projectDisplay = (message: AgentMessage) =>
    projectAgentHarnessTranscriptMessageForDisplay({
      hidden: hiddenTurn || (message as { display?: boolean }).display === false,
      message,
    });
  const messagesSnapshot = [...params.messages];
  const replaceTailUser = (
    current: Extract<AgentMessage, { role: "user" }> | undefined,
    next?: AgentMessage,
  ) => {
    if (isSameUserTurn(messagesSnapshot.at(-1), current)) {
      messagesSnapshot.pop();
    }
    if (next) {
      messagesSnapshot.push(next);
    }
  };
  // The host recorder owns prompt construction. Missing recorders fail closed
  // before dispatch below; the journal never reconstructs a prompt string.
  const currentUser = params.attempt.userTurnTranscriptRecorder?.message;
  if (currentUser) {
    replaceTailUser(currentUser, projectDisplay(currentUser));
  }
  const target = resolveTranscriptTarget(params.attempt);
  const config = params.attempt.config;
  const seenEventIds = new Set<string>();
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
    pendingTools = undefined;
    abortPromise = params.abortSession().catch(() => undefined);
  };
  const claim = (eventId: string) =>
    !firstFailure && !seenEventIds.has(eventId) && Boolean(seenEventIds.add(eventId));

  const schedule = (task: () => Promise<void> | void) => {
    if (firstFailure) {
      return;
    }
    // The SDK checkpoint can advance before this queue. SQLite closes the window inside a
    // complete group; a crash between groups leaves a structurally valid prefix.
    queue = queue.then(() => (firstFailure ? undefined : task())).catch(captureFailure);
  };

  const prepare = (write: PendingWrite): TranscriptMessage | undefined => {
    const message = write.message;
    const hooked = runAgentHarnessBeforeMessageWriteHook({
      message,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
    });
    if (!hooked) {
      return undefined;
    }
    const idempotencyKey = (message as { idempotencyKey?: string }).idempotencyKey;
    const toolIdentity =
      message.role === "toolResult"
        ? { toolCallId: message.toolCallId, toolName: message.toolName }
        : {};
    return projectDisplay({
      ...hooked,
      ...toolIdentity,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...((message as { display?: boolean }).display === false ? { display: false } : {}),
    }) as TranscriptMessage;
  };

  const append = async (write: PendingWrite): Promise<AppendResult> => {
    return (await appendSessionTranscriptMessageByIdentity({
      ...target,
      ...(config ? { config } : {}),
      ...(write.eventId ? { eventId: write.eventId } : {}),
      idempotencyLookup: "scan",
      message: write.message,
      prepareMessageAfterIdempotencyCheck: () => prepare(write),
    })) as AppendResult;
  };

  const appendToolGroup = async (group: ToolGroup) => {
    const writes = [group.assistant, ...group.order.map((id) => group.results.get(id)!)];
    const keys = writes.map((write) => readIdempotencyKey(write.message));
    const persistedKeys = new Set(
      (await readVisibleSessionTranscriptMessageEntries(target)).flatMap((entry) =>
        entry.idempotencyKey ? [entry.idempotencyKey] : [],
      ),
    );
    const persistedCount = keys.filter((key) => key && persistedKeys.has(key)).length;
    if (persistedCount > 0 && persistedCount < writes.length) {
      // The pre-atomic journal was never shipped. Partial identity is corruption,
      // not a runtime compatibility shape; recovery stays fail-closed.
      throw new Error("Copilot transcript found a partial persisted tool group");
    }
    // Hooks must finish before BEGIN. This skips steady-state replay hooks; the
    // transaction still revalidates all identities against cross-process races.
    const messages =
      persistedCount === writes.length ? writes.map((write) => write.message) : writes.map(prepare);
    // Hook omission belongs to policy, but the journal owns structure: one block or
    // structurally destructive rewrite suppresses the complete assistant/result group.
    if (
      messages.some((message) => !message) ||
      !isCompleteToolGroup(messages as TranscriptMessage[], group.order)
    ) {
      return undefined;
    }
    const results = await appendSessionTranscriptMessagesByIdentity({
      ...target,
      ...(config ? { config } : {}),
      messages: writes.map((write, index) => ({
        eventId: write.eventId!,
        idempotencyLookup: "scan" as const,
        message: messages[index]!,
      })),
    });
    if (
      !isCompleteToolGroup(
        results.map((result) => result.message),
        group.order,
      )
    ) {
      throw new Error("Copilot transcript replayed an invalid tool group");
    }
    return results;
  };

  const publish = async (appended: boolean) => {
    if (appended) {
      await publishSessionTranscriptUpdateByIdentity({ ...target }).catch((error: unknown) => {
        console.warn("[copilot-attempt] transcript update notification failed", error);
      });
    }
  };

  const accept = (result: AppendResult): boolean => {
    if (!result) {
      return false;
    }
    messagesSnapshot.push(result.message);
    return result.appended;
  };
  const ownAssistant = (key: string, persisted: boolean) => {
    if (latestAssistantKey === key) {
      assistantTranscriptOwned = true;
      assistantTranscriptIdempotencyKey = persisted ? key : undefined;
    }
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
        replaceTailUser(recorder.message);
        return;
      }
      const persistence = (async () => {
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
        replaceTailUser(resolved);
        if (!outcome) {
          recorder.markBlocked();
          return;
        }
        const persisted = outcome.message as Extract<AgentMessage, { role: "user" }>;
        accept(outcome);
        recorder.markRuntimePersisted(persisted);
        params.attempt.onUserMessagePersisted?.(persisted);
        await publish(outcome.appended);
      })();
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
      if (!claim(input.eventId)) {
        return;
      }
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
        await publish(accept(outcome));
      });
    },
    recordAssistant(input: {
      eventId: string;
      message: Extract<AgentMessage, { role: "assistant" }>;
      toolCallIds: string[];
    }) {
      if (!claim(input.eventId)) {
        return;
      }
      const key = `copilot-sdk:${params.sdkSessionId}:${input.eventId}`;
      latestAssistantKey = key;
      assistantTranscriptOwned = false;
      assistantTranscriptIdempotencyKey = undefined;
      schedule(async () => {
        if (pendingTools) {
          throw new Error("Copilot emitted an assistant message before tool results settled");
        }
        const write = {
          eventId: input.eventId,
          message: { ...input.message, idempotencyKey: key } as TranscriptMessage,
        };
        if (input.toolCallIds.length > 0) {
          pendingTools = {
            assistant: write,
            assistantKey: key,
            order: input.toolCallIds,
            results: new Map(),
          };
          return;
        }
        const outcome = await append(write);
        ownAssistant(key, Boolean(outcome));
        await publish(accept(outcome));
      });
    },
    recordToolResult(input: {
      eventId: string;
      message: Extract<AgentMessage, { role: "toolResult" }>;
      replayIncomplete?: boolean;
    }) {
      if (!claim(input.eventId)) {
        return;
      }
      schedule(async () => {
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
        const results = await appendToolGroup(group);
        let appended = false;
        if (!results) {
          replayInvalid = true;
          ownAssistant(group.assistantKey, false);
        } else {
          for (const result of results) {
            const didAppend = accept(result as AppendResult);
            appended ||= didAppend;
          }
          ownAssistant(group.assistantKey, true);
        }
        pendingTools = undefined;
        for (const write of deferredUserWrites.splice(0)) {
          const outcome = await append(write);
          const didAppend = accept(outcome);
          appended ||= didAppend;
        }
        await publish(appended);
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

function readIdempotencyKey(message: TranscriptMessage): string | undefined {
  const key = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof key === "string" && key ? key : undefined;
}

function isCompleteToolGroup(messages: TranscriptMessage[], order: string[]): boolean {
  const [assistant, ...results] = messages;
  return (
    assistant?.role === "assistant" &&
    JSON.stringify(readAssistantToolCallIds(assistant)) === JSON.stringify(order) &&
    results.length === order.length &&
    results.every(
      (message, index) => message.role === "toolResult" && message.toolCallId === order[index],
    )
  );
}

function isSameUserTurn(
  candidate: AgentMessage | undefined,
  current: Extract<AgentMessage, { role: "user" }> | undefined,
): boolean {
  if (candidate?.role !== "user" || !current) {
    return false;
  }
  if (candidate === current) {
    return true;
  }
  const candidateKey = (candidate as { idempotencyKey?: unknown }).idempotencyKey;
  const currentKey = (current as { idempotencyKey?: unknown }).idempotencyKey;
  if (typeof candidateKey === "string" || typeof currentKey === "string") {
    return candidateKey === currentKey;
  }
  return userText(candidate.content) === userText(current.content);
}

function userText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content.length === 1) {
    const part = content[0] as { text?: unknown; type?: unknown };
    if (part?.type === "text" && typeof part.text === "string") {
      return part.text;
    }
  }
  return JSON.stringify(content) ?? "";
}
