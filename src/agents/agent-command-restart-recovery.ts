import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { RestartRecoveryTerminalDeliveryEvidenceResult } from "../config/sessions/restart-recovery-types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import { hasVisibleAgentPayload } from "./embedded-agent-runner/delivery-evidence.js";
import { mergeAttemptToolMediaPayloads } from "./embedded-agent-runner/run/tool-media-payloads.js";
import { projectTerminalDeliveryEvidence } from "./terminal-delivery-evidence.js";

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeOptionalThreadId(value: unknown): string | undefined {
  return (
    normalizeOptionalString(value) ??
    (typeof value === "number" && Number.isFinite(value) ? String(value) : undefined)
  );
}

function sameDeliveryContext(
  left: DeliveryContext | undefined,
  right: DeliveryContext | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.channel === right.channel &&
    left.to === right.to &&
    left.accountId === right.accountId &&
    normalizeOptionalThreadId(left.threadId) === normalizeOptionalThreadId(right.threadId)
  );
}

/** Replace model-selected media with the exact host-owned delivery set. */
export function constrainRestartRecoveryDeliveryPayloads(
  payloads: ReplyPayload[] | undefined,
  mediaUrls: string[],
  suppressText = false,
): ReplyPayload[] {
  const constrained: ReplyPayload[] = [];
  for (const payload of payloads ?? []) {
    const constrainedPayload: ReplyPayload = {};
    if (!suppressText && typeof payload.text === "string") {
      constrainedPayload.text = payload.text;
    }
    if (payload.isError === true) {
      constrainedPayload.isError = true;
    }
    if (payload.isReasoning === true) {
      constrainedPayload.isReasoning = true;
    }
    if (payload.isCommentary === true) {
      constrainedPayload.isCommentary = true;
    }
    if (payload.isReasoningSnapshot === true) {
      constrainedPayload.isReasoningSnapshot = true;
    }
    if (payload.isCompactionNotice === true) {
      constrainedPayload.isCompactionNotice = true;
    }
    if (payload.isFallbackNotice === true) {
      constrainedPayload.isFallbackNotice = true;
    }
    if (payload.isStatusNotice === true) {
      constrainedPayload.isStatusNotice = true;
    }
    if (Object.keys(constrainedPayload).length > 0) {
      constrained.push(constrainedPayload);
    }
  }
  const exactMediaUrls = Array.from(
    new Set(mediaUrls.map((url) => url.trim()).filter((url) => url.length > 0)),
  );
  if (exactMediaUrls.length === 0) {
    return constrained;
  }

  if (!suppressText) {
    const visibleReplyIndex = constrained.findIndex(
      (payload) =>
        payload.isCommentary !== true &&
        payload.isCompactionNotice !== true &&
        payload.isFallbackNotice !== true &&
        payload.isStatusNotice !== true &&
        hasVisibleAgentPayload(
          { payloads: [payload] },
          {
            includeErrorPayloads: false,
            includeReasoningPayloads: false,
            includeSilentReplyPayloads: false,
          },
        ),
    );
    if (visibleReplyIndex >= 0) {
      const visibleReply = constrained[visibleReplyIndex];
      if (visibleReply) {
        // Recovery owns the exact artifacts; merge them with the actual final
        // reply so automatic delivery cannot emit a caption before its media.
        const [mergedReply] =
          mergeAttemptToolMediaPayloads({
            payloads: [visibleReply],
            toolMediaUrls: exactMediaUrls,
            hostOwnedToolMediaUrls: exactMediaUrls,
            toolTrustedLocalMedia: true,
            sourceReplyDeliveryMode: "automatic",
          }) ?? [];
        if (mergedReply) {
          constrained[visibleReplyIndex] = mergedReply;
          return constrained;
        }
      }
    }
  }

  constrained.push({ mediaUrls: exactMediaUrls, trustedLocalMedia: true });
  return constrained;
}

/** Reduce a terminal result to bounded, route-checkable delivery evidence. */
export function buildRestartRecoveryTerminalDeliveryEvidence(
  result: Parameters<typeof projectTerminalDeliveryEvidence>[0],
): RestartRecoveryTerminalDeliveryEvidenceResult {
  const projected = projectTerminalDeliveryEvidence(result);
  const { unsafeSideEffectsDetected, ...legacyEvidence } = projected;
  return {
    ...legacyEvidence,
    ...(unsafeSideEffectsDetected ? { restartUnsafeSideEffectsDetected: true as const } : {}),
  };
}

export function shouldPersistCurrentRunSessionCleanup(
  current: SessionEntry | undefined,
  sessionId: string,
): boolean {
  return (
    current !== undefined && current.sessionId === sessionId && current.abortedLastRun !== true
  );
}

export function shouldPersistRestartRecoveryContextClaim(
  current: SessionEntry | undefined,
  sessionId: string,
  runId: string,
  allowCreate: boolean,
): boolean {
  if (!current) {
    return allowCreate;
  }
  if (!shouldPersistCurrentRunSessionCleanup(current, sessionId)) {
    return false;
  }
  return (
    current.restartRecoveryDeliveryRunId === undefined ||
    current.restartRecoveryDeliveryRunId === runId
  );
}

export function shouldPersistRestartRecoveryCleanup(
  current: SessionEntry | undefined,
  sessionId: string,
  runId: string,
): boolean {
  return (
    shouldPersistCurrentRunSessionCleanup(current, sessionId) &&
    current?.restartRecoveryDeliveryRunId === runId
  );
}

export function buildCurrentRunRestartRecoveryClaim(params: {
  deliveryContext?: DeliveryContext;
  deliveryMediaUrls?: string[];
  disableMessageTool?: boolean;
  entry: SessionEntry;
  forceRestartSafeTools?: boolean;
  runId: string;
  sourceIngress?: SessionEntry["restartRecoverySourceIngress"];
  sourceRunId?: string;
  sourceReplyDeliveryMode?: SessionEntry["restartRecoverySourceReplyDeliveryMode"];
  suppressTextDelivery?: boolean;
}): Pick<
  SessionEntry,
  | "restartRecoveryDeliveryContext"
  | "restartRecoveryDeliveryMediaUrls"
  | "restartRecoveryDisableMessageTool"
  | "restartRecoveryDeliveryRunId"
  | "restartRecoveryDeliverySourceRunId"
  | "restartRecoveryForceSafeTools"
  | "restartRecoverySourceIngress"
  | "restartRecoverySourceReplyDeliveryMode"
  | "restartRecoverySuppressTextDelivery"
> {
  // Recovery can preclaim a run by id. Preserve its original source semantics
  // while the resumed RPC replaces only the active delivery run id.
  const adoptsExistingClaim = params.entry.restartRecoveryDeliveryRunId === params.runId;
  if (
    adoptsExistingClaim &&
    params.deliveryContext !== undefined &&
    !sameDeliveryContext(params.entry.restartRecoveryDeliveryContext, params.deliveryContext)
  ) {
    throw new Error("restart recovery delivery route changed after the run was claimed");
  }
  const createsTranscriptOnlySourceClaim =
    params.sourceRunId !== undefined && params.deliveryContext === undefined;
  const createsScopedDeliveryClaim = params.sourceRunId !== undefined;
  if (!adoptsExistingClaim && createsScopedDeliveryClaim && !params.sourceIngress) {
    throw new Error("restart recovery source ownership is required for a new claim");
  }
  return {
    restartRecoveryDeliveryContext: adoptsExistingClaim
      ? params.entry.restartRecoveryDeliveryContext
      : params.deliveryContext,
    restartRecoveryDeliveryMediaUrls: adoptsExistingClaim
      ? params.entry.restartRecoveryDeliveryMediaUrls
      : createsScopedDeliveryClaim && params.deliveryMediaUrls !== undefined
        ? [...params.deliveryMediaUrls]
        : undefined,
    restartRecoveryDisableMessageTool: adoptsExistingClaim
      ? params.entry.restartRecoveryDisableMessageTool
      : createsScopedDeliveryClaim && params.disableMessageTool === true
        ? true
        : undefined,
    restartRecoverySuppressTextDelivery: adoptsExistingClaim
      ? params.entry.restartRecoverySuppressTextDelivery
      : createsScopedDeliveryClaim && params.suppressTextDelivery === true
        ? true
        : undefined,
    restartRecoveryDeliveryRunId:
      params.deliveryContext || adoptsExistingClaim || createsTranscriptOnlySourceClaim
        ? params.runId
        : undefined,
    restartRecoveryDeliverySourceRunId: adoptsExistingClaim
      ? params.entry.restartRecoveryDeliverySourceRunId
      : params.sourceRunId,
    restartRecoverySourceIngress: adoptsExistingClaim
      ? params.entry.restartRecoverySourceIngress
      : createsScopedDeliveryClaim
        ? params.sourceIngress
        : undefined,
    restartRecoverySourceReplyDeliveryMode: adoptsExistingClaim
      ? params.entry.restartRecoverySourceReplyDeliveryMode
      : params.sourceRunId
        ? params.sourceReplyDeliveryMode
        : undefined,
    restartRecoveryForceSafeTools: adoptsExistingClaim
      ? params.entry.restartRecoveryForceSafeTools
      : createsScopedDeliveryClaim && params.forceRestartSafeTools === true
        ? true
        : undefined,
  };
}
