import { isDeepStrictEqual } from "node:util";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";
import type {
  RestartRecoveryTerminalDeliveryEvidence,
  RestartRecoveryTerminalDeliveryEvidenceResult,
} from "./restart-recovery-types.js";
import type { SessionEntry } from "./types.js";

const MAX_TERMINAL_RUN_IDS = 64;

type RestartRecoveryChannelAuthority = {
  deliveryContext: DeliveryContext & { channel: string; to: string };
  sourceTurnId: string;
};

function normalizeRunId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Resolves only a complete durable channel claim; session-route fallbacks carry no authority. */
export function resolveRestartRecoveryChannelAuthority(
  entry: SessionEntry,
): RestartRecoveryChannelAuthority | undefined {
  const sourceTurnId = normalizeRunId(entry.restartRecoveryDeliverySourceRunId);
  const deliveryContext = normalizeDeliveryContext(entry.restartRecoveryDeliveryContext);
  const channel = normalizeRunId(deliveryContext?.channel);
  const to = normalizeRunId(deliveryContext?.to);
  if (
    entry.restartRecoverySourceIngress !== "channel" ||
    !sourceTurnId ||
    !channel ||
    !to ||
    !isDeliverableMessageChannel(channel)
  ) {
    return undefined;
  }
  return {
    sourceTurnId,
    deliveryContext: { ...deliveryContext, channel, to },
  };
}

function normalizeThreadId(value: unknown): string | undefined {
  return (
    normalizeRunId(value) ??
    (typeof value === "number" && Number.isFinite(value) ? String(value) : undefined)
  );
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = Array.from(
    new Set(
      value.flatMap((item) => {
        const normalized = normalizeRunId(item);
        return normalized ? [normalized] : [];
      }),
    ),
  );
  return values.length > 0 ? values : undefined;
}

function normalizePresentStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return normalizeStringArray(value) ?? [];
}

function normalizeTerminalDeliveryEvidenceResult(
  value: unknown,
): RestartRecoveryTerminalDeliveryEvidenceResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const captured = record.captured === true ? (true as const) : undefined;
  const rawPayloads = Array.isArray(record.payloads) ? record.payloads : undefined;
  const payloads: RestartRecoveryTerminalDeliveryEvidenceResult["payloads"] = rawPayloads
    ? rawPayloads.slice(0, 64).map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return {};
        }
        const payload = item as Record<string, unknown>;
        const mediaUrls = normalizeStringArray(payload.mediaUrls);
        const visible = typeof payload.visible === "boolean" ? payload.visible : undefined;
        const evidence: { mediaUrls?: string[]; visible?: boolean } = {};
        if (mediaUrls) {
          evidence.mediaUrls = mediaUrls;
        }
        if (visible !== undefined) {
          evidence.visible = visible;
        }
        return evidence;
      })
    : undefined;
  const payloadsTruncated =
    record.payloadsTruncated === true || (rawPayloads?.length ?? 0) > 64
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
    RestartRecoveryTerminalDeliveryEvidenceResult["deliveryStatus"]
  >["payloadOutcomes"] = Array.isArray(rawStatus?.payloadOutcomes)
    ? rawStatus.payloadOutcomes.slice(0, 64).flatMap((item) => {
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
  const errorMessage = normalizeRunId(rawStatus?.errorMessage);
  const deliveryStatus: RestartRecoveryTerminalDeliveryEvidenceResult["deliveryStatus"] = status
    ? {
        status,
        ...(errorMessage ? { errorMessage } : {}),
        ...(payloadOutcomes?.length ? { payloadOutcomes } : {}),
      }
    : undefined;
  const rawMessagingToolSentTargets = Array.isArray(record.messagingToolSentTargets)
    ? record.messagingToolSentTargets
    : undefined;
  const messagingToolSentTargets: RestartRecoveryTerminalDeliveryEvidenceResult["messagingToolSentTargets"] =
    rawMessagingToolSentTargets
      ? rawMessagingToolSentTargets.slice(0, 64).flatMap((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return [];
          }
          const target = item as Record<string, unknown>;
          const provider = normalizeRunId(target.provider);
          const accountId = normalizeRunId(target.accountId);
          const to = normalizeRunId(target.to);
          const threadId = normalizeThreadId(target.threadId);
          const mediaUrls = normalizeStringArray(target.mediaUrls);
          const visible = typeof target.visible === "boolean" ? target.visible : undefined;
          if (!provider && !accountId && !to && !threadId && !mediaUrls && visible === undefined) {
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
              ...(mediaUrls ? { mediaUrls } : {}),
              ...(visible !== undefined ? { visible } : {}),
            },
          ];
        })
      : undefined;
  const messagingToolSentTargetsTruncated =
    record.messagingToolSentTargetsTruncated === true ||
    (rawMessagingToolSentTargets?.length ?? 0) > 64
      ? (true as const)
      : undefined;
  const messagingToolAggregateEvidenceUnaccounted =
    record.messagingToolAggregateEvidenceUnaccounted === true ? (true as const) : undefined;
  const restartUnsafeSideEffectsDetected =
    record.restartUnsafeSideEffectsDetected === true ? (true as const) : undefined;
  if (
    !captured &&
    !payloads?.length &&
    !payloadsTruncated &&
    !deliveryStatus &&
    !messagingToolSentTargets?.length &&
    !messagingToolSentTargetsTruncated &&
    !messagingToolAggregateEvidenceUnaccounted &&
    !restartUnsafeSideEffectsDetected
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
    ...(restartUnsafeSideEffectsDetected ? { restartUnsafeSideEffectsDetected } : {}),
  };
}

function normalizeRestartRecoveryTerminalDeliveryEvidence(
  value: unknown,
): RestartRecoveryTerminalDeliveryEvidence[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const evidence: RestartRecoveryTerminalDeliveryEvidence[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const runId = normalizeRunId((item as Record<string, unknown>).runId);
    const result = normalizeTerminalDeliveryEvidenceResult(item);
    if (!runId || !result) {
      continue;
    }
    const previousIndex = evidence.findIndex((entry) => entry.runId === runId);
    if (previousIndex >= 0) {
      evidence.splice(previousIndex, 1);
    }
    evidence.push({ runId, ...result });
  }
  const bounded = evidence.slice(-MAX_TERMINAL_RUN_IDS);
  return bounded.length > 0 ? bounded : undefined;
}

/** Keeps a bounded durable set of client runs that must never execute again. */
function normalizeRestartRecoveryTerminalRunIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const runIds: string[] = [];
  for (const item of value) {
    const runId = normalizeRunId(item);
    if (!runId) {
      continue;
    }
    const previousIndex = runIds.indexOf(runId);
    if (previousIndex >= 0) {
      runIds.splice(previousIndex, 1);
    }
    runIds.push(runId);
  }
  const bounded = runIds.slice(-MAX_TERMINAL_RUN_IDS);
  return bounded.length > 0 ? bounded : undefined;
}

type RestartRecoveryNormalizedField =
  | "restartRecoveryBeforeAgentReplyState"
  | "restartRecoveryDeliveryReceiptState"
  | "restartRecoveryDeliveryToolCallId"
  | "restartRecoveryDeliveryMediaUrls"
  | "restartRecoveryDisableMessageTool"
  | "restartRecoverySuppressTextDelivery"
  | "restartRecoveryDeliveryRequestFingerprint"
  | "restartRecoveryDeliveryRunId"
  | "restartRecoveryDeliverySourceRunId"
  | "restartRecoveryRequesterAccountId"
  | "restartRecoveryRequesterSenderId"
  | "restartRecoverySameChannelThreadRequired"
  | "restartRecoverySourceIngress"
  | "restartRecoverySourceReplyDeliveryMode"
  | "restartRecoveryTerminalDeliveryEvidence"
  | "restartRecoveryTerminalRunIds";

function sameOptionalStringArray(left: unknown, right: string[] | undefined): boolean {
  if (!Array.isArray(left) || !right) {
    return left === undefined && right === undefined;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Compares normalized durable terminal-source tombstones by value and order. */
export function sameRestartRecoveryTerminalRunIds(left: unknown, right: unknown): boolean {
  return sameOptionalStringArray(left, normalizeRestartRecoveryTerminalRunIds(right));
}

/** Normalizes restart-claim fields while preserving an already-canonical array identity. */
export function normalizeRestartRecoveryEntryFields(
  entry: SessionEntry,
  assign: <K extends RestartRecoveryNormalizedField>(
    key: K,
    value: SessionEntry[K] | undefined,
  ) => void,
): void {
  const deliveryMediaUrls = normalizePresentStringArray(entry.restartRecoveryDeliveryMediaUrls);
  assign(
    "restartRecoveryDeliveryMediaUrls",
    sameOptionalStringArray(entry.restartRecoveryDeliveryMediaUrls, deliveryMediaUrls)
      ? entry.restartRecoveryDeliveryMediaUrls
      : deliveryMediaUrls,
  );
  assign(
    "restartRecoveryDisableMessageTool",
    entry.restartRecoveryDisableMessageTool === true ? true : undefined,
  );
  assign(
    "restartRecoverySuppressTextDelivery",
    entry.restartRecoverySuppressTextDelivery === true ? true : undefined,
  );
  assign(
    "restartRecoveryBeforeAgentReplyState",
    entry.restartRecoveryBeforeAgentReplyState === "admitted" ||
      entry.restartRecoveryBeforeAgentReplyState === "pending" ||
      entry.restartRecoveryBeforeAgentReplyState === "continue" ||
      entry.restartRecoveryBeforeAgentReplyState === "handled-silent" ||
      entry.restartRecoveryBeforeAgentReplyState === "handled-reply" ||
      entry.restartRecoveryBeforeAgentReplyState === "handled-unrecoverable"
      ? entry.restartRecoveryBeforeAgentReplyState
      : undefined,
  );
  assign(
    "restartRecoveryDeliveryReceiptState",
    entry.restartRecoveryDeliveryReceiptState === "terminal-pending" ||
      entry.restartRecoveryDeliveryReceiptState === "delivered-terminal"
      ? entry.restartRecoveryDeliveryReceiptState
      : undefined,
  );
  assign(
    "restartRecoveryDeliveryToolCallId",
    normalizeRunId(entry.restartRecoveryDeliveryToolCallId),
  );
  assign(
    "restartRecoveryDeliveryRequestFingerprint",
    normalizeRunId(entry.restartRecoveryDeliveryRequestFingerprint),
  );
  assign("restartRecoveryDeliveryRunId", normalizeRunId(entry.restartRecoveryDeliveryRunId));
  assign(
    "restartRecoveryDeliverySourceRunId",
    normalizeRunId(entry.restartRecoveryDeliverySourceRunId),
  );
  assign(
    "restartRecoveryRequesterAccountId",
    normalizeRunId(entry.restartRecoveryRequesterAccountId),
  );
  assign(
    "restartRecoveryRequesterSenderId",
    normalizeRunId(entry.restartRecoveryRequesterSenderId),
  );
  assign(
    "restartRecoverySameChannelThreadRequired",
    entry.restartRecoverySameChannelThreadRequired === true ? true : undefined,
  );
  assign(
    "restartRecoverySourceIngress",
    entry.restartRecoverySourceIngress === "channel" ||
      entry.restartRecoverySourceIngress === "control-ui" ||
      entry.restartRecoverySourceIngress === "internal"
      ? entry.restartRecoverySourceIngress
      : undefined,
  );
  assign(
    "restartRecoverySourceReplyDeliveryMode",
    entry.restartRecoverySourceReplyDeliveryMode === "automatic" ||
      entry.restartRecoverySourceReplyDeliveryMode === "message_tool_only"
      ? entry.restartRecoverySourceReplyDeliveryMode
      : undefined,
  );
  const terminalDeliveryEvidence = normalizeRestartRecoveryTerminalDeliveryEvidence(
    entry.restartRecoveryTerminalDeliveryEvidence,
  );
  assign(
    "restartRecoveryTerminalDeliveryEvidence",
    isDeepStrictEqual(entry.restartRecoveryTerminalDeliveryEvidence, terminalDeliveryEvidence)
      ? entry.restartRecoveryTerminalDeliveryEvidence
      : terminalDeliveryEvidence,
  );
  const terminalRunIds = normalizeRestartRecoveryTerminalRunIds(
    entry.restartRecoveryTerminalRunIds,
  );
  assign(
    "restartRecoveryTerminalRunIds",
    sameOptionalStringArray(entry.restartRecoveryTerminalRunIds, terminalRunIds)
      ? entry.restartRecoveryTerminalRunIds
      : terminalRunIds,
  );
}

function mergeRestartRecoveryTerminalDeliveryEvidence(
  current: unknown,
  appended: unknown,
): RestartRecoveryTerminalDeliveryEvidence[] | undefined {
  return normalizeRestartRecoveryTerminalDeliveryEvidence([
    ...(normalizeRestartRecoveryTerminalDeliveryEvidence(current) ?? []),
    ...(normalizeRestartRecoveryTerminalDeliveryEvidence(appended) ?? []),
  ]);
}

export function getRestartRecoveryTerminalDeliveryEvidence(
  entry: SessionEntry | undefined,
  runId: string,
): RestartRecoveryTerminalDeliveryEvidence | undefined {
  return normalizeRestartRecoveryTerminalDeliveryEvidence(
    entry?.restartRecoveryTerminalDeliveryEvidence,
  )?.find((evidence) => evidence.runId === runId);
}

/** Appends new terminal ids without refreshing or evicting existing members. */
export function mergeRestartRecoveryTerminalRunIds(
  current: unknown,
  appended: unknown,
): string[] | undefined {
  const currentRunIds = normalizeRestartRecoveryTerminalRunIds(current) ?? [];
  const currentSet = new Set(currentRunIds);
  const appendedRunIds = (normalizeRestartRecoveryTerminalRunIds(appended) ?? []).filter(
    (runId) => !currentSet.has(runId),
  );
  return normalizeRestartRecoveryTerminalRunIds([...currentRunIds, ...appendedRunIds]);
}

export function hasRestartRecoveryTerminalRun(
  entry: SessionEntry | undefined,
  runId: string,
): boolean {
  return (
    normalizeRestartRecoveryTerminalRunIds(entry?.restartRecoveryTerminalRunIds)?.includes(
      runId,
    ) === true
  );
}

/** Matches durable source ownership regardless of the surrounding run status. */
export function hasRestartRecoverySourceClaim(
  entry: SessionEntry | null | undefined,
  sourceTurnId: string,
): entry is SessionEntry {
  const normalizedSourceTurnId = normalizeRunId(sourceTurnId);
  return (
    normalizedSourceTurnId !== undefined &&
    normalizeRunId(entry?.restartRecoveryDeliveryRunId) !== undefined &&
    normalizeRunId(entry?.restartRecoveryDeliverySourceRunId) === normalizedSourceTurnId
  );
}

export function hasActiveRestartRecoverySourceClaim(
  entry: SessionEntry | null | undefined,
  sourceTurnId: string,
): entry is SessionEntry {
  return entry?.status === "running" && hasRestartRecoverySourceClaim(entry, sourceTurnId);
}

/** Clears exact active ownership and optionally records its client source as terminal. */
export function buildRestartRecoveryClaimCleanupPatch(params: {
  entry: SessionEntry;
  recordTerminalSource: boolean;
  terminalDeliveryEvidence?: RestartRecoveryTerminalDeliveryEvidenceResult;
  terminalRunId?: string;
  terminalSourceRunId?: string;
}): Partial<SessionEntry> {
  const sourceRunId =
    normalizeRunId(params.terminalSourceRunId) ??
    normalizeRunId(params.entry.restartRecoveryDeliverySourceRunId);
  const terminalRunIds =
    params.recordTerminalSource && (sourceRunId || params.terminalRunId)
      ? mergeRestartRecoveryTerminalRunIds(params.entry.restartRecoveryTerminalRunIds, [
          ...(sourceRunId ? [sourceRunId] : []),
          ...(params.terminalRunId ? [params.terminalRunId] : []),
        ])
      : undefined;
  const terminalDeliveryEvidence =
    params.recordTerminalSource && sourceRunId && params.terminalDeliveryEvidence
      ? mergeRestartRecoveryTerminalDeliveryEvidence(
          params.entry.restartRecoveryTerminalDeliveryEvidence,
          [{ runId: sourceRunId, ...params.terminalDeliveryEvidence }],
        )
      : undefined;
  return {
    restartRecoveryBeforeAgentReplyState: undefined,
    restartRecoveryDeliveryReceiptState: undefined,
    restartRecoveryDeliveryToolCallId: undefined,
    restartRecoveryDeliveryContext: undefined,
    restartRecoveryDeliveryMediaUrls: undefined,
    restartRecoveryDisableMessageTool: undefined,
    restartRecoverySuppressTextDelivery: undefined,
    restartRecoveryDeliveryRequestFingerprint: undefined,
    restartRecoveryDeliveryRunId: undefined,
    restartRecoveryDeliverySourceRunId: undefined,
    restartRecoveryRequesterAccountId: undefined,
    restartRecoveryRequesterSenderId: undefined,
    restartRecoverySameChannelThreadRequired: undefined,
    restartRecoverySourceIngress: undefined,
    restartRecoverySourceReplyDeliveryMode: undefined,
    restartRecoveryForceSafeTools: undefined,
    ...(terminalDeliveryEvidence
      ? { restartRecoveryTerminalDeliveryEvidence: terminalDeliveryEvidence }
      : {}),
    ...(terminalRunIds ? { restartRecoveryTerminalRunIds: terminalRunIds } : {}),
  };
}
