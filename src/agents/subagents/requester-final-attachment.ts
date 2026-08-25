import {
  getAgentEventLifecycleGeneration,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

const REQUESTER_FINAL_ATTACHMENT_KEY = Symbol.for("openclaw.subagents.requesterFinalAttachment");
const REQUESTER_FINAL_ATTACHMENT_MAX_TTL_MS = 2 * 60 * 60 * 1_000;

type RequesterFinalAttachmentBatch = {
  batchRunIds: readonly string[];
  rearmGeneration: number;
};

type RequesterFinalAttachment = {
  requesterAgentId: string;
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterTurnRunId: string;
  lifecycleGeneration: string;
  expiresAt: number;
  append: (text: string) => boolean;
  batch?: RequesterFinalAttachmentBatch;
};

type RequesterFinalAttachmentState = {
  byOwner: Map<string, RequesterFinalAttachment>;
};

const state = resolveGlobalSingleton<RequesterFinalAttachmentState>(
  REQUESTER_FINAL_ATTACHMENT_KEY,
  () => ({ byOwner: new Map() }),
  (value) => value.byOwner.clear(),
);

function ownerKey(requesterAgentId: string, requesterSessionKey: string): string {
  return `${requesterAgentId}\u0000${requesterSessionKey}`;
}

function sameRunIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((runId, index) => runId === right[index]);
}

function getCurrentAttachment(
  requesterAgentId: string,
  requesterSessionKey: string,
): RequesterFinalAttachment | undefined {
  const key = ownerKey(requesterAgentId, requesterSessionKey);
  const attachment = state.byOwner.get(key);
  if (!attachment) {
    return undefined;
  }
  if (
    attachment.expiresAt <= Date.now() ||
    attachment.lifecycleGeneration !== getAgentEventLifecycleGeneration()
  ) {
    state.byOwner.delete(key);
    return undefined;
  }
  return attachment;
}

export function registerRequesterFinalAttachment(params: {
  requesterAgentId: string;
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterTurnRunId: string;
  lifecycleGeneration: string;
  timeoutMs: number;
  append: (text: string) => boolean;
}): {
  releaseProvisional: () => void;
  revoke: () => void;
} {
  const key = ownerKey(params.requesterAgentId, params.requesterSessionKey);
  const attachment: RequesterFinalAttachment = {
    requesterAgentId: params.requesterAgentId,
    requesterSessionKey: params.requesterSessionKey,
    requesterSessionId: params.requesterSessionId,
    requesterTurnRunId: params.requesterTurnRunId,
    lifecycleGeneration: params.lifecycleGeneration,
    expiresAt: Date.now() + Math.min(params.timeoutMs, REQUESTER_FINAL_ATTACHMENT_MAX_TTL_MS),
    append: params.append,
  };
  state.byOwner.set(key, attachment);
  const deleteIfCurrent = (requireProvisional: boolean) => {
    const current = state.byOwner.get(key);
    if (current === attachment && (!requireProvisional || !current.batch)) {
      state.byOwner.delete(key);
    }
  };
  return {
    releaseProvisional: () => deleteIfCurrent(true),
    revoke: () => deleteIfCurrent(false),
  };
}

export function promoteRequesterFinalAttachment(params: {
  requesterAgentId: string;
  requesterSessionKey: string;
  requesterTurnRunId: string;
  batchRunIds: readonly string[];
  rearmGeneration: number;
}): boolean {
  const attachment = getCurrentAttachment(params.requesterAgentId, params.requesterSessionKey);
  if (!attachment || attachment.requesterTurnRunId !== params.requesterTurnRunId) {
    return false;
  }
  attachment.batch = {
    batchRunIds: params.batchRunIds.toSorted(),
    rearmGeneration: params.rearmGeneration,
  };
  return true;
}

export function revokeRequesterFinalAttachment(params: {
  requesterAgentId: string;
  requesterSessionKey: string;
  requesterSessionId?: string;
  batchRunIds?: readonly string[];
  rearmGeneration?: number;
}): boolean {
  const key = ownerKey(params.requesterAgentId, params.requesterSessionKey);
  const attachment = getCurrentAttachment(params.requesterAgentId, params.requesterSessionKey);
  if (
    !attachment ||
    (params.requesterSessionId !== undefined &&
      attachment.requesterSessionId !== params.requesterSessionId) ||
    (params.batchRunIds !== undefined &&
      (!attachment.batch ||
        !sameRunIds(attachment.batch.batchRunIds, params.batchRunIds.toSorted()))) ||
    (params.rearmGeneration !== undefined &&
      attachment.batch?.rearmGeneration !== params.rearmGeneration)
  ) {
    return false;
  }
  state.byOwner.delete(key);
  return true;
}

export function consumeRequesterFinalAttachment(params: {
  requesterAgentId: string;
  requesterSessionKey: string;
  requesterSessionId: string;
  batchRunIds: readonly string[];
  rearmGeneration: number;
  text: string;
}): "appended" | "rejected" | "missing" {
  const key = ownerKey(params.requesterAgentId, params.requesterSessionKey);
  const attachment = getCurrentAttachment(params.requesterAgentId, params.requesterSessionKey);
  const batchRunIds = params.batchRunIds.toSorted();
  if (
    !attachment ||
    attachment.requesterSessionId !== params.requesterSessionId ||
    !attachment.batch ||
    attachment.batch.rearmGeneration !== params.rearmGeneration ||
    !sameRunIds(attachment.batch.batchRunIds, batchRunIds)
  ) {
    return "missing";
  }
  // Claim before invoking provider code so replay and callback failure cannot double-append.
  state.byOwner.delete(key);
  try {
    return attachment.append(params.text) ? "appended" : "rejected";
  } catch {
    return "rejected";
  }
}

registerAgentEventLifecycleRotationHandler("requester-final-attachments", () => {
  state.byOwner.clear();
});
