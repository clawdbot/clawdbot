import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { RestartRecoveryTerminalDeliveryEvidenceResult } from "../config/sessions/restart-recovery-types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import type { AgentCommandOpts } from "./command/types.js";
import {
  collectDeliveredMediaUrls,
  collectMessagingToolDeliveredMediaUrls,
  hasCommittedOutboundDeliveryEvidence,
  hasExplicitlyVisibleAgentPayload,
  hasUnaccountedMessagingToolAggregateEvidence,
  hasVisibleAgentPayload,
  hasVisibleCommittedMessagingToolDeliveryEvidence,
  type AgentDeliveryEvidence,
} from "./embedded-agent-runner/delivery-evidence.js";
import { mergeAttemptToolMediaPayloads } from "./embedded-agent-runner/run/tool-media-payloads.js";

/** Restore the exact host-owned delivery constraints before starting a recovery turn. */
export function resolveCommandRecoveryOptions(params: {
  opts: AgentCommandOpts;
  sessionEntry?: SessionEntry;
  runId: string;
}): AgentCommandOpts {
  const { sessionEntry: entry } = params;
  const media =
    entry?.restartRecoveryDeliveryRunId === params.runId &&
    Array.isArray(entry.restartRecoveryDeliveryMediaUrls)
      ? entry.restartRecoveryDeliveryMediaUrls
      : undefined;
  const opts =
    media !== undefined
      ? {
          ...params.opts,
          internalDeliveryMediaUrls: [...media],
          internalDeliverySuppressText: entry?.restartRecoverySuppressTextDelivery,
          sourceReplyDeliveryMode: entry?.restartRecoverySourceReplyDeliveryMode,
          disableMessageTool: entry?.restartRecoveryDisableMessageTool,
          forceRestartSafeTools: entry?.restartRecoveryForceSafeTools,
        }
      : params.opts;
  if (
    (opts.internalDeliverySuppressText === true && opts.internalDeliveryMediaUrls === undefined) ||
    ((opts.internalDeliveryMediaUrls !== undefined || opts.internalDeliverySuppressText === true) &&
      (opts.forceRestartSafeTools !== true ||
        opts.disableMessageTool !== true ||
        opts.sourceReplyDeliveryMode !== "automatic"))
  ) {
    throw new Error(
      "internal delivery media constraints require automatic delivery with restart-safe tools and no message tool",
    );
  }
  return opts;
}

function normalizeOptionalThreadId(value: unknown): string | undefined {
  return (
    normalizeOptionalString(value) ??
    (typeof value === "number" && Number.isFinite(value) ? String(value) : undefined)
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
    const visibleReplyIndex = constrained.findIndex((payload) =>
      hasVisibleAgentPayload(
        { payloads: [payload] },
        {
          includeErrorPayloads: false,
          includeSilentReplyPayloads: false,
          requireTerminalContent: true,
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
  result: AgentDeliveryEvidence,
): RestartRecoveryTerminalDeliveryEvidenceResult {
  const rawPayloads = Array.isArray(result.payloads) ? result.payloads : undefined;
  const payloads: RestartRecoveryTerminalDeliveryEvidenceResult["payloads"] = Array.isArray(
    rawPayloads,
  )
    ? rawPayloads.slice(0, 64).map((payload) => {
        const mediaUrls = collectDeliveredMediaUrls({ payloads: [payload] });
        const visible = hasExplicitlyVisibleAgentPayload(payload);
        const evidence: { mediaUrls?: string[]; visible?: boolean } = { visible };
        if (mediaUrls.length > 0) {
          evidence.mediaUrls = mediaUrls;
        }
        return evidence;
      })
    : undefined;
  const payloadsTruncated = rawPayloads && rawPayloads.length > 64 ? (true as const) : undefined;
  const rawDeliveryStatus = result.deliveryStatus;
  const status =
    rawDeliveryStatus?.status === "failed" ||
    rawDeliveryStatus?.status === "partial_failed" ||
    rawDeliveryStatus?.status === "sent" ||
    rawDeliveryStatus?.status === "suppressed"
      ? rawDeliveryStatus.status
      : undefined;
  const rawPayloadOutcomes =
    rawDeliveryStatus && typeof rawDeliveryStatus === "object"
      ? (rawDeliveryStatus as { payloadOutcomes?: unknown }).payloadOutcomes
      : undefined;
  const payloadOutcomes: NonNullable<
    RestartRecoveryTerminalDeliveryEvidenceResult["deliveryStatus"]
  >["payloadOutcomes"] = Array.isArray(rawPayloadOutcomes)
    ? rawPayloadOutcomes.flatMap((outcome) => {
        if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
          return [];
        }
        const record = outcome as Record<string, unknown>;
        const outcomeStatus =
          record.status === "failed" || record.status === "sent" || record.status === "suppressed"
            ? record.status
            : undefined;
        if (!outcomeStatus || typeof record.index !== "number" || !Number.isInteger(record.index)) {
          return [];
        }
        return [
          {
            index: record.index,
            status: outcomeStatus,
            ...(typeof record.sentBeforeError === "boolean"
              ? { sentBeforeError: record.sentBeforeError }
              : {}),
          },
        ];
      })
    : undefined;
  const errorMessage = normalizeOptionalString(rawDeliveryStatus?.errorMessage);
  const deliveryStatus: RestartRecoveryTerminalDeliveryEvidenceResult["deliveryStatus"] = status
    ? {
        status,
        ...(errorMessage ? { errorMessage } : {}),
        ...(payloadOutcomes?.length ? { payloadOutcomes } : {}),
      }
    : undefined;
  const rawMessagingToolSentTargets = Array.isArray(result.messagingToolSentTargets)
    ? result.messagingToolSentTargets
    : undefined;
  const messagingToolSentTargets: RestartRecoveryTerminalDeliveryEvidenceResult["messagingToolSentTargets"] =
    rawMessagingToolSentTargets
      ? rawMessagingToolSentTargets.slice(0, 64).flatMap((target) => {
          if (!target || typeof target !== "object" || Array.isArray(target)) {
            return [];
          }
          const record = target as Record<string, unknown>;
          const mediaUrls = collectMessagingToolDeliveredMediaUrls({
            messagingToolSentTargets: [record],
          });
          const visible = hasVisibleCommittedMessagingToolDeliveryEvidence({
            messagingToolSentTargets: [record],
          });
          const evidence: NonNullable<
            RestartRecoveryTerminalDeliveryEvidenceResult["messagingToolSentTargets"]
          >[number] = { visible };
          const provider = normalizeOptionalString(record.provider);
          const accountId = normalizeOptionalString(record.accountId);
          const to = normalizeOptionalString(record.to);
          const threadId = normalizeOptionalThreadId(record.threadId);
          if (provider) {
            evidence.provider = provider;
          }
          if (accountId) {
            evidence.accountId = accountId;
          }
          if (to) {
            evidence.to = to;
          }
          if (threadId) {
            evidence.threadId = threadId;
          }
          if (record.threadImplicit === true) {
            evidence.threadImplicit = true;
          }
          if (record.threadSuppressed === true) {
            evidence.threadSuppressed = true;
          }
          if (mediaUrls.length > 0) {
            evidence.mediaUrls = mediaUrls;
          }
          return [evidence];
        })
      : undefined;
  const messagingToolSentTargetsTruncated =
    rawMessagingToolSentTargets && rawMessagingToolSentTargets.length > 64
      ? (true as const)
      : undefined;
  const messagingToolAggregateEvidenceUnaccounted = hasUnaccountedMessagingToolAggregateEvidence(
    result,
  )
    ? (true as const)
    : undefined;
  const restartUnsafeSideEffectsDetected =
    hasCommittedOutboundDeliveryEvidence(result) ||
    result.didSendDeterministicApprovalPrompt === true
      ? (true as const)
      : undefined;
  return {
    captured: true,
    ...(payloads?.length ? { payloads } : {}),
    ...(payloadsTruncated ? { payloadsTruncated } : {}),
    ...(deliveryStatus ? { deliveryStatus } : {}),
    ...(messagingToolSentTargets?.length ? { messagingToolSentTargets } : {}),
    ...(messagingToolSentTargetsTruncated ? { messagingToolSentTargetsTruncated } : {}),
    ...(messagingToolAggregateEvidenceUnaccounted
      ? { messagingToolAggregateEvidenceUnaccounted }
      : {}),
    ...(restartUnsafeSideEffectsDetected ? { restartUnsafeSideEffectsDetected } : {}),
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
