import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { normalizeMediaReferenceForComparison } from "../../media/media-reference-comparison.js";
import { hasAnyNonEmptyString as hasNonEmptyStringArray } from "../delivery-evidence-values.js";
/**
 * Extracts visible delivery evidence from embedded-agent run results.
 */
import { collectMediaUrlsFromRecord, hasVisibleAgentPayload } from "./message-visibility.js";
export { hasExplicitlyVisibleAgentPayload, hasVisibleAgentPayload } from "./message-visibility.js";

/**
 * Helpers for deciding whether an embedded run produced user-visible or outbound effects.
 *
 * Fallback and retry code uses these checks to avoid rerunning a model after messages, media,
 * cron entries, or spawned sessions have already been delivered.
 */
export type AgentDeliveryEvidence = {
  payloads?: unknown;
  /** Durable recovery evidence sets this when its bounded payload projection omitted entries. */
  payloadsTruncated?: unknown;
  deliveryStatus?: {
    status?: unknown;
    errorMessage?: unknown;
    reason?: unknown;
    payloadOutcomes?: unknown;
  };
  didSendViaMessagingTool?: unknown;
  didSendDeterministicApprovalPrompt?: unknown;
  messagingToolSentTexts?: unknown;
  messagingToolSentMediaUrls?: unknown;
  messagingToolSentTargets?: unknown;
  /** Durable terminal evidence found aggregate sends not represented by target records. */
  messagingToolAggregateEvidenceUnaccounted?: unknown;
  /** Durable recovery found committed effects outside the restart-safe tool contract. */
  restartUnsafeSideEffectsDetected?: unknown;
  /** Durable recovery evidence sets this when its bounded target projection omitted entries. */
  messagingToolSentTargetsTruncated?: unknown;
  acceptedSessionSpawns?: unknown;
  successfulCronAdds?: unknown;
  meta?: {
    toolSummary?: {
      calls?: unknown;
    };
  };
};

type SourceReplyDeliveryEvidence = {
  didDeliverSourceReplyViaMessageTool?: unknown;
  messagingToolSourceReplyPayloads?: unknown;
};

type ExplicitFinalSourceReplyEvidence = {
  messagingToolSentTargets?: unknown;
  messagingToolSourceReplyPayloads?: unknown;
};

function collectSourceReplyFinalMarkers(value: unknown): boolean[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const marker = (entry as { sourceReplyFinal?: unknown }).sourceReplyFinal;
    return typeof marker === "boolean" ? [marker] : [];
  });
}

/** Resolve explicit progress/final evidence, or undefined for legacy runtimes. */
export function resolveExplicitFinalSourceReplyDeliveryEvidence(
  result: ExplicitFinalSourceReplyEvidence,
): boolean | undefined {
  const markers = [
    ...collectSourceReplyFinalMarkers(result.messagingToolSentTargets),
    ...collectSourceReplyFinalMarkers(result.messagingToolSourceReplyPayloads),
  ];
  return markers.length > 0 ? markers.some(Boolean) : undefined;
}

/** Preserve legacy completion semantics unless the runtime emitted progress/final markers. */
export function hasCompletedSourceReplyDeliveryEvidence(
  result: SourceReplyDeliveryEvidence & ExplicitFinalSourceReplyEvidence,
): boolean {
  return (
    resolveExplicitFinalSourceReplyDeliveryEvidence(result) ??
    hasCommittedSourceReplyDeliveryEvidence(result)
  );
}

/** Returns whether messaging-tool evidence completes the current source reply. */
export function hasCompletedMessagingToolDeliveryEvidence(
  result: AgentDeliveryEvidence & SourceReplyDeliveryEvidence & ExplicitFinalSourceReplyEvidence,
): boolean {
  return (
    resolveExplicitFinalSourceReplyDeliveryEvidence(result) ??
    hasMessagingToolDeliveryEvidence(result)
  );
}

/** Returns whether delivery evidence completes the current interactive turn. */
export function hasCompletedTerminalDeliveryEvidence(
  result: AgentDeliveryEvidence & SourceReplyDeliveryEvidence & ExplicitFinalSourceReplyEvidence,
): boolean {
  const explicitFinal = resolveExplicitFinalSourceReplyDeliveryEvidence(result);
  return (
    hasCompletedSourceReplyDeliveryEvidence(result) ||
    (explicitFinal === undefined && hasVisibleOutboundDeliveryEvidence(result)) ||
    result.didSendDeterministicApprovalPrompt === true
  );
}

function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function hasAcceptedSessionSpawnEvidence(value: unknown): boolean {
  return Array.isArray(value)
    ? value.some((entry) => {
        const spawn = asOptionalRecord(entry);
        return hasNonEmptyString(spawn?.runId) && hasNonEmptyString(spawn?.childSessionKey);
      })
    : false;
}

function collectStringValues(value: unknown, output: Set<string>) {
  if (typeof value === "string" && value.trim()) {
    output.add(value.trim());
  } else if (Array.isArray(value)) {
    value.filter(hasNonEmptyString).forEach((entry) => output.add(entry.trim()));
  }
}

function normalizeEvidenceStatus(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() || undefined : undefined;
}

function hasVisibleMessagingToolTarget(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const target = value as {
    text?: unknown;
    mediaUrls?: unknown;
    hasRichContent?: unknown;
    visible?: unknown;
  };
  if (
    "text" in target ||
    "mediaUrls" in target ||
    "hasRichContent" in target ||
    "visible" in target
  ) {
    return (
      hasNonEmptyString(target.text) ||
      hasNonEmptyStringArray(target.mediaUrls) ||
      target.hasRichContent === true ||
      target.visible === true
    );
  }
  return true;
}

/** Collects media URLs from agent payloads and committed messaging-tool delivery metadata. */
export function collectDeliveredMediaUrls(result: AgentDeliveryEvidence): string[] {
  const urls = new Set<string>();
  if (Array.isArray(result.payloads)) {
    for (const payload of result.payloads) {
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        collectMediaUrlsFromRecord(payload as Record<string, unknown>, urls);
      }
    }
  }
  for (const url of collectMessagingToolDeliveredMediaUrls(result)) {
    urls.add(url);
  }
  return Array.from(urls);
}

/** Collects media URLs recorded by messaging-tool sends and their target attachments. */
export function collectMessagingToolDeliveredMediaUrls(
  result: Pick<AgentDeliveryEvidence, "messagingToolSentMediaUrls" | "messagingToolSentTargets">,
): string[] {
  const urls = new Set<string>();
  collectStringValues(result.messagingToolSentMediaUrls, urls);
  if (Array.isArray(result.messagingToolSentTargets)) {
    for (const target of result.messagingToolSentTargets) {
      if (target && typeof target === "object" && !Array.isArray(target)) {
        collectMediaUrlsFromRecord(target as Record<string, unknown>, urls);
      }
    }
  }
  return Array.from(urls);
}

function getPayloadDeliveryStatusRecord(
  result: Pick<AgentDeliveryEvidence, "deliveryStatus">,
): Record<string, unknown> | undefined {
  return result.deliveryStatus && typeof result.deliveryStatus === "object"
    ? (result.deliveryStatus as Record<string, unknown>)
    : undefined;
}

function getPayloadDeliveryOutcomes(
  result: Pick<AgentDeliveryEvidence, "deliveryStatus">,
): unknown[] | undefined {
  const outcomes = getPayloadDeliveryStatusRecord(result)?.payloadOutcomes;
  return Array.isArray(outcomes) ? outcomes : undefined;
}

function collectPayloadOutcomeMediaUrls(
  result: Pick<AgentDeliveryEvidence, "deliveryStatus" | "payloads">,
  statuses: (outcome: Record<string, unknown>) => boolean,
): string[] {
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  const outcomes = getPayloadDeliveryOutcomes(result) ?? [];
  const urls = new Set<string>();
  for (const outcome of outcomes) {
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
      continue;
    }
    const record = outcome as Record<string, unknown>;
    if (!statuses(record)) {
      continue;
    }
    const index =
      typeof record.index === "number" && Number.isInteger(record.index) ? record.index : undefined;
    const payload = index === undefined ? undefined : payloads[index];
    if (!hasDeliverableAgentPayload(payload)) {
      continue;
    }
    for (const url of collectDeliveredMediaUrls({ payloads: [payload] })) {
      urls.add(url);
    }
  }
  return Array.from(urls);
}

function hasDeliverableAgentPayload(payload: unknown): boolean {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const visible = (payload as { visible?: unknown }).visible;
    if (visible === false) {
      return false;
    }
  }
  return hasVisibleAgentPayload(
    { payloads: [payload] },
    { includeErrorPayloads: false, includeReasoningPayloads: false },
  );
}

function collectDeliverablePayloadMediaUrls(payloads: unknown): string[] {
  if (!Array.isArray(payloads)) {
    return [];
  }
  const urls = new Set<string>();
  for (const payload of payloads) {
    if (!hasDeliverableAgentPayload(payload)) {
      continue;
    }
    for (const url of collectDeliveredMediaUrls({ payloads: [payload] })) {
      urls.add(url);
    }
  }
  return Array.from(urls);
}

/** Collect automatic-delivery media proven sent by aggregate or per-payload evidence. */
export function collectAutomaticDeliveredMediaUrls(
  result: Pick<AgentDeliveryEvidence, "deliveryStatus" | "payloads">,
  options: {
    includeAmbiguousSinglePayloadFailure?: boolean;
    includeSuppressedOutcomes?: boolean;
  } = {},
): string[] {
  const outcomes = getPayloadDeliveryOutcomes(result);
  if (outcomes) {
    const payloads = Array.isArray(result.payloads) ? result.payloads : [];
    return collectPayloadOutcomeMediaUrls(
      result,
      (outcome) =>
        normalizeEvidenceStatus(outcome.status) === "sent" ||
        (options.includeSuppressedOutcomes !== false &&
          normalizeEvidenceStatus(outcome.status) === "suppressed") ||
        (options.includeAmbiguousSinglePayloadFailure === true &&
          normalizeEvidenceStatus(outcome.status) === "failed" &&
          outcome.sentBeforeError === true &&
          outcomes.length === 1 &&
          payloads.length === 1),
    );
  }
  const status = normalizeEvidenceStatus(result.deliveryStatus?.status);
  return status === "sent" || status === "suppressed"
    ? collectDeliverablePayloadMediaUrls(result.payloads)
    : [];
}

/** Collect media whose send may have committed before a per-payload failure. */
export function collectAmbiguousAutomaticMediaUrls(
  result: Pick<AgentDeliveryEvidence, "deliveryStatus" | "payloads">,
): string[] {
  return collectPayloadOutcomeMediaUrls(
    result,
    (outcome) =>
      normalizeEvidenceStatus(outcome.status) === "failed" && outcome.sentBeforeError === true,
  );
}

/** Check that a partial automatic send classifies every expected-media payload. */
export function hasCompleteAutomaticMediaDeliveryOutcomeEvidence(
  result: Pick<AgentDeliveryEvidence, "deliveryStatus" | "payloads" | "payloadsTruncated">,
  expectedMediaUrls: readonly string[],
): boolean {
  if (result.payloadsTruncated === true) {
    return false;
  }
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  const outcomes = Array.isArray(result.deliveryStatus?.payloadOutcomes)
    ? result.deliveryStatus.payloadOutcomes
    : [];
  if (payloads.length === 0 || outcomes.length === 0) {
    return false;
  }
  const classifiedIndexes = new Set<number>();
  for (const outcome of outcomes) {
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
      continue;
    }
    const record = outcome as Record<string, unknown>;
    const index =
      typeof record.index === "number" &&
      Number.isInteger(record.index) &&
      record.index >= 0 &&
      record.index < payloads.length
        ? record.index
        : undefined;
    const status = normalizeEvidenceStatus(record.status);
    const classified =
      status === "sent" ||
      status === "suppressed" ||
      (status === "failed" && typeof record.sentBeforeError === "boolean");
    if (index !== undefined && classified) {
      classifiedIndexes.add(index);
    }
  }
  const expected = new Set(expectedMediaUrls.map(normalizeMediaReferenceForComparison));
  return payloads.every((payload, index) => {
    const containsExpectedMedia = collectDeliveredMediaUrls({ payloads: [payload] }).some((url) =>
      expected.has(normalizeMediaReferenceForComparison(url)),
    );
    return !containsExpectedMedia || classifiedIndexes.has(index);
  });
}

/** Preserve batch send evidence and policy reasons hidden by the first suppressed payload. */
export function getAutomaticDeliveryEvidence(
  result: Pick<AgentDeliveryEvidence, "deliveryStatus">,
): { mayHaveSent: boolean; suppressionReason?: string } {
  let suppressionReason =
    normalizeEvidenceStatus(result.deliveryStatus?.status) === "suppressed" &&
    typeof result.deliveryStatus?.reason === "string"
      ? result.deliveryStatus.reason
      : undefined;
  let mayHaveSent =
    normalizeEvidenceStatus(result.deliveryStatus?.status) === "partial_failed" ||
    suppressionReason === "adapter_returned_no_identity";
  for (const outcome of getPayloadDeliveryOutcomes(result) ?? []) {
    const record = asOptionalRecord(outcome);
    const status = normalizeEvidenceStatus(record?.status);
    mayHaveSent ||=
      status === "sent" ||
      record?.sentBeforeError === true ||
      (status === "suppressed" && record?.reason === "adapter_returned_no_identity");
    if (
      status === "suppressed" &&
      typeof record?.reason === "string" &&
      (!suppressionReason || suppressionReason === "no_visible_payload")
    ) {
      suppressionReason = record.reason;
    }
  }
  return { mayHaveSent, suppressionReason };
}

function hasPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Extracts a gateway result payload when the response carries delivery evidence fields. */
export function getGatewayAgentResult(response: unknown): AgentDeliveryEvidence | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const candidate = hasAgentDeliveryEvidenceShape(response)
    ? response
    : (response as { result?: unknown }).result;
  if (!candidate || typeof candidate !== "object" || !hasAgentDeliveryEvidenceShape(candidate)) {
    return null;
  }
  return candidate as AgentDeliveryEvidence;
}

function hasAgentDeliveryEvidenceShape(value: object): boolean {
  return (
    "payloads" in value ||
    "deliveryStatus" in value ||
    "didSendViaMessagingTool" in value ||
    "messagingToolSentTexts" in value ||
    "messagingToolSentMediaUrls" in value ||
    "messagingToolSentTargets" in value ||
    "acceptedSessionSpawns" in value ||
    "successfulCronAdds" in value ||
    "meta" in value
  );
}

/** Returns whether the messaging tool attempted or committed an outbound delivery. */
export function hasMessagingToolDeliveryEvidence(result: AgentDeliveryEvidence): boolean {
  return (
    result.didSendViaMessagingTool === true || hasCommittedMessagingToolDeliveryEvidence(result)
  );
}

/** Returns whether messaging-tool metadata proves committed text, media, or target delivery. */
export function hasCommittedMessagingToolDeliveryEvidence(
  result: Pick<
    AgentDeliveryEvidence,
    "messagingToolSentTexts" | "messagingToolSentMediaUrls" | "messagingToolSentTargets"
  >,
): boolean {
  return (
    hasNonEmptyStringArray(result.messagingToolSentTexts) ||
    hasNonEmptyStringArray(result.messagingToolSentMediaUrls) ||
    hasNonEmptyArray(result.messagingToolSentTargets)
  );
}

function collectNonEmptyStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []))
    : [];
}

function hasUnaccountedStrings(aggregate: string[], accounted: string[]): boolean {
  const remaining = new Map<string, number>();
  for (const value of accounted) {
    remaining.set(value, (remaining.get(value) ?? 0) + 1);
  }
  for (const value of aggregate) {
    const count = remaining.get(value) ?? 0;
    if (count === 0) {
      return true;
    }
    if (count === 1) {
      remaining.delete(value);
    } else {
      remaining.set(value, count - 1);
    }
  }
  return false;
}

/** Returns whether aggregate message-tool sends lack route-checkable target records. */
export function hasUnaccountedMessagingToolAggregateEvidence(
  result: Pick<
    AgentDeliveryEvidence,
    | "didSendViaMessagingTool"
    | "messagingToolSentTexts"
    | "messagingToolSentMediaUrls"
    | "messagingToolSentTargets"
  >,
): boolean {
  const routeCheckableTargets = Array.isArray(result.messagingToolSentTargets)
    ? result.messagingToolSentTargets.flatMap((target) => {
        if (!target || typeof target !== "object" || Array.isArray(target)) {
          return [];
        }
        const record = target as Record<string, unknown>;
        return typeof record.to === "string" && record.to.trim() ? [record] : [];
      })
    : [];
  const aggregateTexts = collectNonEmptyStringArray(result.messagingToolSentTexts);
  const aggregateMediaUrls = collectNonEmptyStringArray(result.messagingToolSentMediaUrls);
  const accountedTexts = routeCheckableTargets.flatMap((target) =>
    typeof target.text === "string" && target.text.trim() ? [target.text.trim()] : [],
  );
  const accountedMediaUrls = routeCheckableTargets.flatMap((target) =>
    collectNonEmptyStringArray(target.mediaUrls),
  );
  if (
    hasUnaccountedStrings(aggregateTexts, accountedTexts) ||
    hasUnaccountedStrings(aggregateMediaUrls, accountedMediaUrls)
  ) {
    return true;
  }
  return (
    result.didSendViaMessagingTool === true &&
    routeCheckableTargets.length === 0 &&
    aggregateTexts.length === 0 &&
    aggregateMediaUrls.length === 0
  );
}

/** Returns whether messaging-tool metadata proves a user-visible committed delivery. */
export function hasVisibleCommittedMessagingToolDeliveryEvidence(
  result: Pick<
    AgentDeliveryEvidence,
    "messagingToolSentTexts" | "messagingToolSentMediaUrls" | "messagingToolSentTargets"
  >,
): boolean {
  return (
    hasNonEmptyStringArray(result.messagingToolSentTexts) ||
    hasNonEmptyStringArray(result.messagingToolSentMediaUrls) ||
    (Array.isArray(result.messagingToolSentTargets) &&
      result.messagingToolSentTargets.some(hasVisibleMessagingToolTarget))
  );
}

function hasGranularMessagingToolDeliveryEvidence(result: AgentDeliveryEvidence): boolean {
  return (
    result.messagingToolSentTexts !== undefined ||
    result.messagingToolSentMediaUrls !== undefined ||
    result.messagingToolSentTargets !== undefined
  );
}

/** Returns whether a source reply was visibly delivered through the message tool. */
export function hasCommittedSourceReplyDeliveryEvidence(
  result: SourceReplyDeliveryEvidence,
): boolean {
  return (
    result.didDeliverSourceReplyViaMessageTool === true ||
    hasVisibleAgentPayload({ payloads: result.messagingToolSourceReplyPayloads })
  );
}

/** Returns whether outbound metadata proves a visible message, spawn, or cron side effect. */
export function hasVisibleOutboundDeliveryEvidence(result: AgentDeliveryEvidence): boolean {
  return (
    hasVisibleCommittedMessagingToolDeliveryEvidence(result) ||
    // The coarse flag is the only evidence available for older callers. Once detailed
    // metadata exists, it owns visibility so blank sends cannot suppress recovery.
    (result.didSendViaMessagingTool === true &&
      !hasGranularMessagingToolDeliveryEvidence(result)) ||
    hasAcceptedSessionSpawnEvidence(result.acceptedSessionSpawns) ||
    hasPositiveNumber(result.successfulCronAdds)
  );
}

/** Returns whether committed non-messaging resource effects make replay unsafe. */
function hasCommittedNonMessagingOutboundDeliveryEvidence(
  result: Pick<AgentDeliveryEvidence, "acceptedSessionSpawns" | "successfulCronAdds">,
): boolean {
  return (
    hasAcceptedSessionSpawnEvidence(result.acceptedSessionSpawns) ||
    hasPositiveNumber(result.successfulCronAdds)
  );
}

/** Returns whether committed outbound evidence makes replay unsafe. */
export function hasCommittedOutboundDeliveryEvidence(result: AgentDeliveryEvidence): boolean {
  return (
    hasMessagingToolDeliveryEvidence(result) ||
    hasCommittedNonMessagingOutboundDeliveryEvidence(result)
  );
}

/** Returns whether any tool progress or outbound side effect makes a retry unsafe. */
export function hasOutboundDeliveryEvidence(result: AgentDeliveryEvidence): boolean {
  return (
    hasCommittedOutboundDeliveryEvidence(result) ||
    hasPositiveNumber(result.meta?.toolSummary?.calls)
  );
}

/** Formats an agent-command delivery failure message from delivery status metadata. */
export function getAgentCommandDeliveryFailure(result: AgentDeliveryEvidence): string | undefined {
  const status = normalizeEvidenceStatus(result.deliveryStatus?.status);
  if (status !== "failed" && status !== "partial_failed") {
    return undefined;
  }
  const message = result.deliveryStatus?.errorMessage;
  if (hasNonEmptyString(message)) {
    return message;
  }
  return status === "partial_failed" ? "agent delivery partially failed" : "agent delivery failed";
}
