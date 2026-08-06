import {
  collectDeliveredMediaUrls,
  collectMessagingToolDeliveredMediaUrls,
  hasCommittedOutboundDeliveryEvidence,
  hasUnaccountedMessagingToolAggregateEvidence,
  hasVisibleAgentPayload,
  hasVisibleCommittedMessagingToolDeliveryEvidence,
  type AgentDeliveryEvidence,
} from "./embedded-agent-runner/delivery-evidence.js";

export const MAX_TERMINAL_DELIVERY_EVIDENCE_ITEMS = 64;

export type TerminalDeliveryEvidenceResult = {
  /** The terminal result was captured even when it contained no visible or delivery evidence. */
  captured?: true;
  payloads?: Array<{ mediaUrls?: string[]; visible?: boolean }>;
  payloadsTruncated?: true;
  deliveryStatus?: {
    status: "failed" | "partial_failed" | "sent" | "suppressed";
    errorMessage?: string;
    payloadOutcomes?: Array<{
      index: number;
      status: "failed" | "sent" | "suppressed";
      sentBeforeError?: boolean;
    }>;
  };
  messagingToolSentTargets?: Array<{
    provider?: string;
    accountId?: string;
    to?: string;
    threadId?: string;
    threadImplicit?: boolean;
    threadSuppressed?: boolean;
    mediaUrls?: string[];
    visible?: boolean;
  }>;
  messagingToolSentTargetsTruncated?: true;
  /** Aggregate committed sends were not all represented by route-checkable target records. */
  messagingToolAggregateEvidenceUnaccounted?: true;
  /** The terminal run reported a committed effect that makes fresh replay unsafe. */
  unsafeSideEffectsDetected?: true;
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeOptionalThreadId(value: unknown): string | undefined {
  return (
    normalizeOptionalString(value) ??
    (typeof value === "number" && Number.isFinite(value) ? String(value) : undefined)
  );
}

function hasExplicitlyVisiblePayload(payload: unknown): boolean {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const visible = (payload as { visible?: unknown }).visible;
    if (typeof visible === "boolean") {
      return visible;
    }
  }
  return hasVisibleAgentPayload(
    { payloads: [payload] },
    { includeErrorPayloads: false, includeReasoningPayloads: false },
  );
}

/** Reduce a terminal result to bounded, route-checkable delivery evidence. */
export function projectTerminalDeliveryEvidence(
  result: AgentDeliveryEvidence & Pick<TerminalDeliveryEvidenceResult, "unsafeSideEffectsDetected">,
): TerminalDeliveryEvidenceResult {
  const rawPayloads = Array.isArray(result.payloads) ? result.payloads : undefined;
  const payloads: TerminalDeliveryEvidenceResult["payloads"] = Array.isArray(rawPayloads)
    ? rawPayloads.slice(0, MAX_TERMINAL_DELIVERY_EVIDENCE_ITEMS).map((payload) => {
        const mediaUrls = collectDeliveredMediaUrls({ payloads: [payload] });
        const visible = hasExplicitlyVisiblePayload(payload);
        const evidence: { mediaUrls?: string[]; visible?: boolean } = { visible };
        if (mediaUrls.length > 0) {
          evidence.mediaUrls = mediaUrls;
        }
        return evidence;
      })
    : undefined;
  const payloadsTruncated =
    rawPayloads && rawPayloads.length > MAX_TERMINAL_DELIVERY_EVIDENCE_ITEMS
      ? (true as const)
      : undefined;
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
    TerminalDeliveryEvidenceResult["deliveryStatus"]
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
        if (
          !outcomeStatus ||
          typeof record.index !== "number" ||
          !Number.isInteger(record.index) ||
          record.index < 0
        ) {
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
  const deliveryStatus: TerminalDeliveryEvidenceResult["deliveryStatus"] = status
    ? {
        status,
        ...(errorMessage ? { errorMessage } : {}),
        ...(payloadOutcomes?.length ? { payloadOutcomes } : {}),
      }
    : undefined;
  const rawMessagingToolSentTargets = Array.isArray(result.messagingToolSentTargets)
    ? result.messagingToolSentTargets
    : undefined;
  const messagingToolSentTargets: TerminalDeliveryEvidenceResult["messagingToolSentTargets"] =
    rawMessagingToolSentTargets
      ? rawMessagingToolSentTargets
          .slice(0, MAX_TERMINAL_DELIVERY_EVIDENCE_ITEMS)
          .flatMap((target) => {
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
              TerminalDeliveryEvidenceResult["messagingToolSentTargets"]
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
    rawMessagingToolSentTargets &&
    rawMessagingToolSentTargets.length > MAX_TERMINAL_DELIVERY_EVIDENCE_ITEMS
      ? (true as const)
      : undefined;
  const messagingToolAggregateEvidenceUnaccounted = hasUnaccountedMessagingToolAggregateEvidence(
    result,
  )
    ? (true as const)
    : undefined;
  const unsafeSideEffectsDetected =
    result.unsafeSideEffectsDetected === true ||
    result.restartUnsafeSideEffectsDetected === true ||
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
    ...(unsafeSideEffectsDetected ? { unsafeSideEffectsDetected } : {}),
  };
}

/** Normalizes bounded terminal delivery evidence without admitting raw delivery metadata. */
export function normalizeTerminalDeliveryEvidenceResult(
  value: unknown,
): TerminalDeliveryEvidenceResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const captured = record.captured === true ? (true as const) : undefined;
  const rawPayloads = Array.isArray(record.payloads) ? record.payloads : undefined;
  const payloads: TerminalDeliveryEvidenceResult["payloads"] = rawPayloads
    ? rawPayloads.slice(0, MAX_TERMINAL_DELIVERY_EVIDENCE_ITEMS).map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return {};
        }
        const payload = item as Record<string, unknown>;
        const mediaUrls = Array.isArray(payload.mediaUrls)
          ? Array.from(
              new Set(
                payload.mediaUrls.flatMap((mediaUrl) => {
                  const normalized = normalizeOptionalString(mediaUrl);
                  return normalized ? [normalized] : [];
                }),
              ),
            )
          : undefined;
        const visible = typeof payload.visible === "boolean" ? payload.visible : undefined;
        const evidence: { mediaUrls?: string[]; visible?: boolean } = {};
        if (mediaUrls?.length) {
          evidence.mediaUrls = mediaUrls;
        }
        if (visible !== undefined) {
          evidence.visible = visible;
        }
        return evidence;
      })
    : undefined;
  const payloadsTruncated =
    record.payloadsTruncated === true ||
    (rawPayloads?.length ?? 0) > MAX_TERMINAL_DELIVERY_EVIDENCE_ITEMS
      ? (true as const)
      : undefined;
  const rawStatus =
    record.deliveryStatus && typeof record.deliveryStatus === "object"
      ? (record.deliveryStatus as Record<string, unknown>)
      : undefined;
  const status =
    rawStatus?.status === "failed" ||
    rawStatus?.status === "partial_failed" ||
    rawStatus?.status === "sent" ||
    rawStatus?.status === "suppressed"
      ? rawStatus.status
      : undefined;
  const payloadOutcomes: NonNullable<
    TerminalDeliveryEvidenceResult["deliveryStatus"]
  >["payloadOutcomes"] = Array.isArray(rawStatus?.payloadOutcomes)
    ? rawStatus.payloadOutcomes.slice(0, MAX_TERMINAL_DELIVERY_EVIDENCE_ITEMS).flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return [];
        }
        const outcome = item as Record<string, unknown>;
        const outcomeStatus =
          outcome.status === "failed" ||
          outcome.status === "sent" ||
          outcome.status === "suppressed"
            ? outcome.status
            : undefined;
        if (
          !outcomeStatus ||
          typeof outcome.index !== "number" ||
          !Number.isInteger(outcome.index) ||
          outcome.index < 0
        ) {
          return [];
        }
        return [
          {
            index: outcome.index,
            status: outcomeStatus,
            ...(typeof outcome.sentBeforeError === "boolean"
              ? { sentBeforeError: outcome.sentBeforeError }
              : {}),
          },
        ];
      })
    : undefined;
  const errorMessage = normalizeOptionalString(rawStatus?.errorMessage);
  const deliveryStatus: TerminalDeliveryEvidenceResult["deliveryStatus"] = status
    ? {
        status,
        ...(errorMessage ? { errorMessage } : {}),
        ...(payloadOutcomes?.length ? { payloadOutcomes } : {}),
      }
    : undefined;
  const rawMessagingToolSentTargets = Array.isArray(record.messagingToolSentTargets)
    ? record.messagingToolSentTargets
    : undefined;
  const messagingToolSentTargets: TerminalDeliveryEvidenceResult["messagingToolSentTargets"] =
    rawMessagingToolSentTargets
      ? rawMessagingToolSentTargets
          .slice(0, MAX_TERMINAL_DELIVERY_EVIDENCE_ITEMS)
          .flatMap((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              return [];
            }
            const target = item as Record<string, unknown>;
            const provider = normalizeOptionalString(target.provider);
            const accountId = normalizeOptionalString(target.accountId);
            const to = normalizeOptionalString(target.to);
            const threadId = normalizeOptionalThreadId(target.threadId);
            const mediaUrls = Array.isArray(target.mediaUrls)
              ? Array.from(
                  new Set(
                    target.mediaUrls.flatMap((mediaUrl) => {
                      const normalized = normalizeOptionalString(mediaUrl);
                      return normalized ? [normalized] : [];
                    }),
                  ),
                )
              : undefined;
            const visible = typeof target.visible === "boolean" ? target.visible : undefined;
            if (
              !provider &&
              !accountId &&
              !to &&
              !threadId &&
              !mediaUrls?.length &&
              visible === undefined &&
              target.threadImplicit !== true &&
              target.threadSuppressed !== true
            ) {
              return [];
            }
            return [
              {
                ...(provider ? { provider } : {}),
                ...(accountId ? { accountId } : {}),
                ...(to ? { to } : {}),
                ...(threadId ? { threadId } : {}),
                ...(target.threadImplicit === true ? { threadImplicit: true as const } : {}),
                ...(target.threadSuppressed === true ? { threadSuppressed: true as const } : {}),
                ...(mediaUrls?.length ? { mediaUrls } : {}),
                ...(visible !== undefined ? { visible } : {}),
              },
            ];
          })
      : undefined;
  const messagingToolSentTargetsTruncated =
    record.messagingToolSentTargetsTruncated === true ||
    (rawMessagingToolSentTargets?.length ?? 0) > MAX_TERMINAL_DELIVERY_EVIDENCE_ITEMS
      ? (true as const)
      : undefined;
  const messagingToolAggregateEvidenceUnaccounted =
    record.messagingToolAggregateEvidenceUnaccounted === true ? (true as const) : undefined;
  const unsafeSideEffectsDetected =
    record.unsafeSideEffectsDetected === true ? (true as const) : undefined;
  if (
    !captured &&
    !payloads?.length &&
    !payloadsTruncated &&
    !deliveryStatus &&
    !messagingToolSentTargets?.length &&
    !messagingToolSentTargetsTruncated &&
    !messagingToolAggregateEvidenceUnaccounted &&
    !unsafeSideEffectsDetected
  ) {
    return undefined;
  }
  return {
    ...(captured ? { captured } : {}),
    ...(payloads?.length ? { payloads } : {}),
    ...(payloadsTruncated ? { payloadsTruncated } : {}),
    ...(deliveryStatus ? { deliveryStatus } : {}),
    ...(messagingToolSentTargets?.length ? { messagingToolSentTargets } : {}),
    ...(messagingToolSentTargetsTruncated ? { messagingToolSentTargetsTruncated } : {}),
    ...(messagingToolAggregateEvidenceUnaccounted
      ? { messagingToolAggregateEvidenceUnaccounted }
      : {}),
    ...(unsafeSideEffectsDetected ? { unsafeSideEffectsDetected } : {}),
  };
}
