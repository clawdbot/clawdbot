import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { loadSessionEntry, updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
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
    pendingFinalDeliveryText: undefined,
    pendingFinalDeliveryCreatedAt: undefined,
    pendingFinalDeliveryLastAttemptAt: undefined,
    pendingFinalDeliveryAttemptCount: undefined,
    pendingFinalDeliveryLastError: undefined,
    pendingFinalDeliveryContext: undefined,
    pendingFinalDeliveryIntentId: undefined,
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
  const currentPresent = Boolean(entry.pendingFinalDelivery || entry.pendingFinalDeliveryText);
  if (currentPresent !== expected.present) {
    return false;
  }
  if (expected.intentId) {
    return normalizeOptionalString(entry.pendingFinalDeliveryIntentId) === expected.intentId;
  }
  return (
    entry.pendingFinalDeliveryCreatedAt === expected.createdAt &&
    normalizeOptionalString(entry.pendingFinalDeliveryText) === expected.text
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
      if (!entry.pendingFinalDelivery && !entry.pendingFinalDeliveryText) {
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
    const entry = loadSessionEntry({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
    });
    if (
      params.intentId &&
      normalizeOptionalString(entry?.pendingFinalDeliveryIntentId) !== params.intentId
    ) {
      return { present: false };
    }
    return {
      present: Boolean(entry?.pendingFinalDelivery || entry?.pendingFinalDeliveryText),
      intentId: params.intentId ?? normalizeOptionalString(entry?.pendingFinalDeliveryIntentId),
      createdAt:
        typeof entry?.pendingFinalDeliveryCreatedAt === "number"
          ? entry.pendingFinalDeliveryCreatedAt
          : undefined,
      text: normalizeOptionalString(entry?.pendingFinalDeliveryText),
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
      const pendingText = normalizeOptionalString(entry.pendingFinalDeliveryText);
      if (!entry.pendingFinalDelivery && !pendingText) {
        return null;
      }
      const pendingPayloads = pendingText
        ? resolvePendingFinalDeliveryPayloads({
            intentId: identity.intentId,
            pendingText,
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
        if (retryText) {
          return {
            pendingFinalDelivery: true,
            pendingFinalDeliveryText: retryText,
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
