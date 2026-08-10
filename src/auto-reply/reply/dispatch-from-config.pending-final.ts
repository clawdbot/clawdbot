import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  loadSessionEntryReadOnly,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { ReplyPayload } from "../reply-payload.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import {
  buildPendingFinalDeliveryText,
  sanitizePendingFinalDeliveryText,
} from "./pending-final-delivery.js";
import type { ReplyDispatchDeliveryOutcome } from "./reply-dispatcher.js";

type SettledFinalDelivery = {
  outcome: ReplyDispatchDeliveryOutcome;
  payload: ReplyPayload;
};

type PendingFinalDeliveryIdentity = {
  createdAt?: number;
  intentId?: string;
  present: boolean;
  text?: string;
};

function buildPendingFinalDeliveryCleanupPatch(entry: SessionEntry): Partial<SessionEntry> {
  // An active receipt/claim may outlive outer reply settlement. Only claimless pending finals
  // borrow hook provenance until their exact transport intent settles.
  const clearsRestartRecoveryProof =
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) === undefined;
  const completesHookHandledTurn =
    clearsRestartRecoveryProof &&
    (entry.restartRecoveryBeforeAgentReplyState === "handled-reply" ||
      entry.restartRecoveryBeforeAgentReplyState === "handled-unrecoverable");
  const endedAt = completesHookHandledTurn ? Date.now() : undefined;
  return {
    pendingFinalDelivery: undefined,
    ...(clearsRestartRecoveryProof
      ? {
          restartRecoveryBeforeAgentReplyState: undefined,
          restartRecoverySourceIngress: undefined,
          restartRecoveryForceSafeTools: undefined,
        }
      : {}),
    ...(endedAt !== undefined
      ? {
          abortedLastRun: false,
          endedAt,
          lifecycleRunId: undefined,
          runtimeMs:
            typeof entry.startedAt === "number"
              ? Math.max(0, endedAt - entry.startedAt)
              : undefined,
          status: "done" as const,
        }
      : {}),
  };
}

function matchesPendingFinalDeliveryIdentity(
  entry: SessionEntry,
  expected: PendingFinalDeliveryIdentity,
): boolean {
  const pending = entry.pendingFinalDelivery;
  const currentPresent = pending !== undefined;
  if (currentPresent !== expected.present) {
    return false;
  }
  if (expected.intentId) {
    return pending?.intentId === expected.intentId;
  }
  return (
    pending?.createdAt === expected.createdAt &&
    (pending?.kind === "replayable" ? pending.text : undefined) === expected.text
  );
}

export async function clearPendingFinalDeliveryAfterSuccess(params: {
  identity?: PendingFinalDeliveryIdentity;
  storePath?: string;
  sessionKey?: string;
}): Promise<void> {
  const identity = params.identity;
  if (!params.storePath || !params.sessionKey || !identity?.present) {
    return;
  }
  await updateSessionEntry(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    async (entry) => {
      if (!matchesPendingFinalDeliveryIdentity(entry, identity)) {
        return null;
      }
      if (!entry.pendingFinalDelivery) {
        return null;
      }
      return {
        ...buildPendingFinalDeliveryCleanupPatch(entry),
        updatedAt: Date.now(),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
}

export function capturePendingFinalDeliveryIdentity(params: {
  intentId?: string;
  storePath?: string;
  sessionKey?: string;
}): PendingFinalDeliveryIdentity | undefined {
  if (!params.storePath || !params.sessionKey) {
    return undefined;
  }
  try {
    const entry = loadSessionEntryReadOnly({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
    });
    const pending = entry?.pendingFinalDelivery;
    if (params.intentId && pending?.intentId !== params.intentId) {
      return { present: false };
    }
    return {
      present: pending !== undefined,
      intentId: params.intentId ?? pending?.intentId,
      createdAt: pending?.createdAt,
      text: pending?.kind === "replayable" ? pending.text : undefined,
    };
  } catch {
    return params.intentId ? { present: true, intentId: params.intentId } : undefined;
  }
}

function buildPendingFinalDeliveryRetryText(payloads: ReplyPayload[]): string {
  return sanitizePendingFinalDeliveryText(
    payloads
      .map(
        (payload) =>
          getReplyPayloadMetadata(payload)?.pendingFinalDeliveryRetryText ??
          buildPendingFinalDeliveryText([payload]),
      )
      .filter(Boolean)
      .join("\n\n"),
  );
}

function resolvePendingFinalDeliveryPayloads(params: {
  intentId?: string;
  pendingText: string;
  replies: ReplyPayload[];
}): ReplyPayload[] | undefined {
  const intentReplies = params.intentId
    ? params.replies.filter((reply) => {
        const metadata = getReplyPayloadMetadata(reply);
        return (
          metadata?.pendingFinalDeliveryIntentId === params.intentId &&
          metadata?.pendingFinalDeliveryRetryText !== undefined
        );
      })
    : [];
  const intentContributors = intentReplies.filter(
    (reply) => getReplyPayloadMetadata(reply)?.pendingFinalDeliveryRetryText,
  );
  const intentText = buildPendingFinalDeliveryRetryText(intentContributors);
  if (
    intentReplies.length > 0 &&
    intentText.replace(/\s+/g, " ").trim() === params.pendingText.replace(/\s+/g, " ").trim()
  ) {
    return intentContributors;
  }
  const contributingReplies = params.replies.filter(
    (reply) => buildPendingFinalDeliveryText([reply]) !== "",
  );
  if (buildPendingFinalDeliveryText(contributingReplies) === params.pendingText) {
    return contributingReplies;
  }
  const exactMatches = contributingReplies.filter(
    (reply) => buildPendingFinalDeliveryText([reply]) === params.pendingText,
  );
  return exactMatches.length === 1 ? exactMatches : undefined;
}

export async function reconcilePendingFinalDeliveryAfterSettlement(params: {
  deliveries: SettledFinalDelivery[];
  identity?: PendingFinalDeliveryIdentity;
  replies: ReplyPayload[];
  storePath?: string;
  sessionKey?: string;
}): Promise<void> {
  const identity = params.identity;
  if (!params.storePath || !params.sessionKey || !identity?.present) {
    return;
  }
  await updateSessionEntry(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    async (entry) => {
      if (!matchesPendingFinalDeliveryIdentity(entry, identity)) {
        return null;
      }
      const pending = entry.pendingFinalDelivery;
      if (!pending) {
        return null;
      }
      const pendingPayloads =
        pending.kind === "replayable"
          ? resolvePendingFinalDeliveryPayloads({
              intentId: identity.intentId,
              pendingText: pending.text,
              replies: params.replies,
            })
          : undefined;
      const pendingPayloadSet = pendingPayloads ? new Set(pendingPayloads) : undefined;
      const relevantDeliveries = pendingPayloadSet
        ? params.deliveries.filter((delivery) => pendingPayloadSet.has(delivery.payload))
        : params.deliveries;
      const ownsEveryPendingPayload =
        !pendingPayloadSet || relevantDeliveries.length === pendingPayloadSet.size;
      const failedBeforeDeliver = relevantDeliveries.filter(
        (delivery) => delivery.outcome === "failed-before-deliver",
      );

      if (
        relevantDeliveries.length > 0 &&
        failedBeforeDeliver.length === relevantDeliveries.length
      ) {
        return null;
      }
      if (pendingPayloadSet && ownsEveryPendingPayload && failedBeforeDeliver.length > 0) {
        const retryText = buildPendingFinalDeliveryRetryText(
          failedBeforeDeliver.map((delivery) => delivery.payload),
        );
        if (retryText && pending.kind === "replayable") {
          return {
            pendingFinalDelivery: { ...pending, text: retryText },
            updatedAt: Date.now(),
          };
        }
      }
      return {
        ...buildPendingFinalDeliveryCleanupPatch(entry),
        updatedAt: Date.now(),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
}
