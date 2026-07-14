import { createHash } from "node:crypto";
import type {
  WorkerTranscriptCommitParams,
  WorkerTranscriptMessage,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { stableStringify } from "../../agents/stable-stringify.js";
import { redactTranscriptMessage } from "../../agents/transcript-redact.js";
import {
  loadSessionEntry,
  publishTranscriptUpdate,
  replaceSessionEntrySync,
  withTranscriptWriteTransaction,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { resolveWorkerSessionTarget, type ResolvedWorkerSessionTarget } from "./session-target.js";
import {
  createWorkerTranscriptCommitStore,
  type WorkerTranscriptCommitInput,
  type WorkerTranscriptCommitOutcome,
  type WorkerTranscriptCommitStore,
} from "./transcript-commit-store.js";

type WorkerTranscriptCommitterOptions = {
  getConfig: () => OpenClawConfig;
  store?: WorkerTranscriptCommitStore;
};

type SemanticAgentMessage = Extract<AgentMessage, { role: "assistant" | "toolResult" | "user" }>;
type CommittedAgentMessage = SemanticAgentMessage & { idempotencyKey: string };

type AppliedTranscriptMessage = {
  appended: boolean;
  message: CommittedAgentMessage;
  messageId: string;
  messageSeq?: number;
};

type ApplyTranscriptCommitResult =
  | { ok: true; messages: AppliedTranscriptMessage[] }
  | { ok: false; reason: "invalid-batch" | "session-not-attached" | "stale-base-leaf" };

type PersistedCommitResolution =
  | { kind: "ambiguous" | "missing" }
  | { kind: "found"; messages: AppliedTranscriptMessage[] };

function cloneContentPart(
  part: WorkerTranscriptMessage["content"][number],
): WorkerTranscriptMessage["content"][number] {
  if (part.type === "text") {
    return {
      type: "text",
      text: part.text,
      ...(part.textSignature ? { textSignature: part.textSignature } : {}),
    };
  }
  if (part.type === "image") {
    return { type: "image", data: part.data, mimeType: part.mimeType };
  }
  if (part.type === "thinking") {
    return {
      type: "thinking",
      thinking: part.thinking,
      ...(part.thinkingSignature ? { thinkingSignature: part.thinkingSignature } : {}),
      ...(part.redacted === undefined ? {} : { redacted: part.redacted }),
    };
  }
  return {
    type: "toolCall",
    id: part.id,
    name: part.name,
    arguments: structuredClone(part.arguments),
    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
    ...(part.executionMode ? { executionMode: part.executionMode } : {}),
  };
}

function buildCommittedMessage(
  message: WorkerTranscriptMessage,
  idempotencyKey: string,
): CommittedAgentMessage {
  const content = message.content.map((part) => cloneContentPart(part));
  if (message.role === "user") {
    return {
      role: "user",
      content,
      timestamp: message.timestamp,
      idempotencyKey,
    } as CommittedAgentMessage;
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content,
      ...(message.details === undefined ? {} : { details: structuredClone(message.details) }),
      isError: message.isError,
      timestamp: message.timestamp,
      idempotencyKey,
    } as CommittedAgentMessage;
  }
  return {
    role: "assistant",
    content,
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.diagnostics
      ? {
          diagnostics: message.diagnostics.map((diagnostic) => ({
            type: diagnostic.type,
            timestamp: diagnostic.timestamp,
            ...(diagnostic.error
              ? {
                  error: {
                    ...(diagnostic.error.name === undefined ? {} : { name: diagnostic.error.name }),
                    message: diagnostic.error.message,
                    ...(diagnostic.error.stack === undefined
                      ? {}
                      : { stack: diagnostic.error.stack }),
                    ...(diagnostic.error.code === undefined ? {} : { code: diagnostic.error.code }),
                  },
                }
              : {}),
            ...(diagnostic.details ? { details: structuredClone(diagnostic.details) } : {}),
          })),
        }
      : {}),
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      ...(message.usage.contextUsage
        ? { contextUsage: structuredClone(message.usage.contextUsage) }
        : {}),
      totalTokens: message.usage.totalTokens,
      cost: {
        input: message.usage.cost.input,
        output: message.usage.cost.output,
        cacheRead: message.usage.cost.cacheRead,
        cacheWrite: message.usage.cost.cacheWrite,
        total: message.usage.cost.total,
        ...(message.usage.cost.totalOrigin ? { totalOrigin: message.usage.cost.totalOrigin } : {}),
      },
    },
    stopReason: message.stopReason,
    ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
    ...(message.errorCode === undefined ? {} : { errorCode: message.errorCode }),
    ...(message.errorType === undefined ? {} : { errorType: message.errorType }),
    ...(message.errorBody === undefined ? {} : { errorBody: message.errorBody }),
    timestamp: message.timestamp,
    idempotencyKey,
  } as CommittedAgentMessage;
}

function requestHash(request: WorkerTranscriptCommitParams): string {
  return createHash("sha256")
    .update(
      stableStringify({
        baseLeafId: request.baseLeafId,
        messages: request.messages,
      }),
    )
    .digest("hex");
}

function messageIdempotencyKey(params: {
  sessionId: string;
  runEpoch: number;
  seq: number;
  index: number;
}): string {
  const digest = createHash("sha256")
    .update([params.sessionId, params.runEpoch, params.seq, params.index].join("\0"))
    .digest("base64url");
  return `worker-commit-${digest}`;
}

function readMessageIdempotencyKey(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const value = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isCommittedAgentMessage(message: unknown): message is CommittedAgentMessage {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const role = (message as { role?: unknown }).role;
  return (
    (role === "user" || role === "assistant" || role === "toolResult") &&
    readMessageIdempotencyKey(message) !== undefined
  );
}

function resolveActiveCommitPrefix(params: {
  baseLeafId: string | null;
  manager: SessionManager;
  messages: readonly CommittedAgentMessage[];
}):
  | {
      activeVisibleEntryCount: number;
      ok: true;
      recoveredMessages: AppliedTranscriptMessage[];
    }
  | { ok: false } {
  const activeBranch = params.manager.getBranch();
  const activeVisibleEntryCount = activeBranch.filter(
    (entry) => entry.type === "message" || entry.type === "compaction",
  ).length;
  if (params.manager.getLeafId() === params.baseLeafId) {
    return { activeVisibleEntryCount, ok: true, recoveredMessages: [] };
  }

  const baseIndex =
    params.baseLeafId === null
      ? -1
      : activeBranch.findIndex((entry) => entry.id === params.baseLeafId);
  if (params.baseLeafId !== null && baseIndex < 0) {
    return { ok: false };
  }

  const activeSuffix = activeBranch.slice(baseIndex + 1);
  if (activeSuffix.length === 0) {
    return { ok: false };
  }

  const recoveredMessages: AppliedTranscriptMessage[] = [];
  for (const [index, entry] of activeSuffix.slice(0, params.messages.length).entries()) {
    const expectedKey = readMessageIdempotencyKey(params.messages[index]);
    if (
      entry.type !== "message" ||
      !expectedKey ||
      !isCommittedAgentMessage(entry.message) ||
      readMessageIdempotencyKey(entry.message) !== expectedKey
    ) {
      return { ok: false };
    }
    recoveredMessages.push({
      appended: false,
      message: entry.message,
      messageId: entry.id,
    });
  }
  return { activeVisibleEntryCount, ok: true, recoveredMessages };
}

function resolvePersistedCommitAcrossDag(params: {
  baseLeafId: string | null;
  manager: SessionManager;
  messages: readonly CommittedAgentMessage[];
}): PersistedCommitResolution {
  const childrenByParent = new Map<string | null, ReturnType<SessionManager["getEntries"]>>();
  for (const entry of params.manager.getEntries()) {
    const children = childrenByParent.get(entry.parentId) ?? [];
    children.push(entry);
    childrenByParent.set(entry.parentId, children);
  }

  const completedPaths: AppliedTranscriptMessage[][] = [];
  const visit = (
    parentId: string | null,
    messageIndex: number,
    path: AppliedTranscriptMessage[],
  ): void => {
    if (completedPaths.length > 1) {
      return;
    }
    if (messageIndex === params.messages.length) {
      completedPaths.push(path);
      return;
    }
    const expectedKey = readMessageIdempotencyKey(params.messages[messageIndex]);
    if (!expectedKey) {
      return;
    }
    for (const entry of childrenByParent.get(parentId) ?? []) {
      if (
        entry.type !== "message" ||
        !isCommittedAgentMessage(entry.message) ||
        readMessageIdempotencyKey(entry.message) !== expectedKey
      ) {
        continue;
      }
      visit(entry.id, messageIndex + 1, [
        ...path,
        { appended: false, message: entry.message, messageId: entry.id },
      ]);
    }
  };

  // The pending ledger binds the request hash while each deterministic key
  // binds tuple + index. Do not compare re-redacted content across restarts.
  visit(params.baseLeafId, 0, []);
  if (completedPaths.length > 1) {
    return { kind: "ambiguous" };
  }
  const messages = completedPaths[0];
  return messages ? { kind: "found", messages } : { kind: "missing" };
}

async function applyWorkerTranscriptCommit(params: {
  config: OpenClawConfig;
  messages: readonly CommittedAgentMessage[];
  recoverPersistedBatch: boolean;
  requestedBaseLeafId: string | null;
  sessionId: string;
  target: ResolvedWorkerSessionTarget;
}): Promise<ApplyTranscriptCommitResult> {
  const redactedMessages = params.messages.map(
    (message) => redactTranscriptMessage(message, params.config) as CommittedAgentMessage,
  );
  const applied = await withTranscriptWriteTransaction(params.target, ({ sessionFile }) => {
    const currentEntry = loadSessionEntry(params.target);
    if (!currentEntry || currentEntry.sessionId !== params.sessionId) {
      return { ok: false as const, reason: "session-not-attached" as const };
    }

    const manager = SessionManager.open(sessionFile);
    if (params.recoverPersistedBatch) {
      // Only a pending ledger row may prove an off-branch batch: the agent DB
      // can commit before the shared replay ledger records its terminal result.
      const recovered = resolvePersistedCommitAcrossDag({
        baseLeafId: params.requestedBaseLeafId,
        manager,
        messages: redactedMessages,
      });
      if (recovered.kind === "found") {
        return { ok: true as const, messages: recovered.messages };
      }
      if (recovered.kind === "ambiguous") {
        return { ok: false as const, reason: "invalid-batch" as const };
      }
    }
    const prefix = resolveActiveCommitPrefix({
      baseLeafId: params.requestedBaseLeafId,
      manager,
      messages: redactedMessages,
    });
    if (!prefix.ok) {
      return { ok: false as const, reason: "stale-base-leaf" as const };
    }

    const messages = [...prefix.recoveredMessages];
    let nextMessageSeq = prefix.activeVisibleEntryCount;
    for (const message of redactedMessages.slice(prefix.recoveredMessages.length)) {
      const messageId = manager.appendMessage(message, {
        config: params.config,
        // Active-path recovery owns dedupe. A global key scan could reuse an
        // id from an abandoned branch while SessionManager advances another id.
        idempotencyLookup: "caller-checked",
      });
      nextMessageSeq += 1;
      messages.push({
        appended: true,
        message,
        messageId,
        messageSeq: nextMessageSeq,
      });
    }

    const freshEntry = loadSessionEntry(params.target);
    if (!freshEntry || freshEntry.sessionId !== params.sessionId) {
      return { ok: false as const, reason: "session-not-attached" as const };
    }
    const appendedCount = messages.filter((message) => message.appended).length;
    const nextEntry = {
      ...freshEntry,
      sessionFile,
      ...(appendedCount > 0 ? { updatedAt: Math.max(freshEntry.updatedAt ?? 0, Date.now()) } : {}),
    };
    replaceSessionEntrySync(params.target, nextEntry);
    return { ok: true as const, messages };
  });
  if (!applied.ok) {
    return applied;
  }

  for (const message of applied.messages) {
    if (!message.appended) {
      continue;
    }
    await publishTranscriptUpdate(params.target, {
      message: message.message,
      messageId: message.messageId,
      messageSeq: message.messageSeq,
    });
  }
  return applied;
}

/** Applies ordered, idempotent semantic worker turns to the canonical session transcript. */
export function createWorkerTranscriptCommitter(options: WorkerTranscriptCommitterOptions) {
  const store = options.store ?? createWorkerTranscriptCommitStore();
  const sessionOperations = new KeyedAsyncQueue();

  const commit = async (params: {
    identity: WorkerConnectionIdentity;
    request: WorkerTranscriptCommitParams;
  }): Promise<WorkerTranscriptCommitOutcome> => {
    const sessionId = params.identity.sessionId;
    if (!sessionId) {
      return { ok: false, reason: "session-not-attached" };
    }
    if (params.request.runEpoch !== params.identity.ownerEpoch) {
      return { ok: false, reason: "epoch-mismatch" };
    }
    return await sessionOperations.enqueue(sessionId, async () => {
      const input: WorkerTranscriptCommitInput = {
        environmentId: params.identity.environmentId,
        sessionId,
        runEpoch: params.request.runEpoch,
        seq: params.request.seq,
        requestHash: requestHash(params.request),
      };
      const started = store.begin(input);
      if (started.kind === "replay") {
        return started.outcome;
      }
      if (started.kind === "rejected") {
        return { ok: false, reason: "invalid-batch" };
      }

      const config = options.getConfig();
      const target = resolveWorkerSessionTarget(config, sessionId);
      if (!target) {
        return store.complete({
          ...input,
          outcome: { ok: false, reason: "session-not-attached" },
        });
      }
      const messages = params.request.messages.map((message, index) =>
        buildCommittedMessage(
          message,
          messageIdempotencyKey({
            sessionId,
            runEpoch: params.request.runEpoch,
            seq: params.request.seq,
            index,
          }),
        ),
      );
      const applied = await applyWorkerTranscriptCommit({
        config,
        messages,
        recoverPersistedBatch: started.kind === "recover",
        requestedBaseLeafId: params.request.baseLeafId,
        sessionId,
        target,
      });
      if (!applied.ok) {
        return store.complete({ ...input, outcome: { ok: false, reason: applied.reason } });
      }
      const entryIds = applied.messages.map((message) => message.messageId);
      const newLeafId = entryIds.at(-1);
      if (entryIds.length !== params.request.messages.length || !newLeafId) {
        return store.complete({
          ...input,
          outcome: { ok: false, reason: "invalid-batch" },
        });
      }
      return store.complete({
        ...input,
        outcome: { ok: true, result: { entryIds, newLeafId } },
      });
    });
  };

  return { commit };
}
