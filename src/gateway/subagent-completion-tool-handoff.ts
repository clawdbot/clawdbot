import { randomUUID } from "node:crypto";
import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SubagentCompletionToolHandoffRegistration,
  TrustedSubagentCompletionHandoff,
} from "../agents/subagent-announce-handoff.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";

const SUBAGENT_COMPLETION_TOOL_HANDOFF_TTL_MS = 5 * 60 * 1000;

type SubagentCompletionToolHandoffEntry = SubagentCompletionToolHandoffRegistration & {
  expiresAtMs: number;
};

const handoffs = resolveGlobalMap<string, SubagentCompletionToolHandoffEntry>(
  Symbol.for("openclaw.subagentCompletionToolHandoffs"),
  "close-and-restart",
);

function normalizeRegistration(
  params: SubagentCompletionToolHandoffRegistration,
): SubagentCompletionToolHandoffRegistration | undefined {
  const sourceSessionKey = normalizeOptionalString(params.sourceSessionKey);
  const sourceSessionId = normalizeOptionalString(params.sourceSessionId);
  const targetSessionKey = normalizeOptionalString(params.targetSessionKey);
  const targetSessionId = normalizeOptionalString(params.targetSessionId);
  const idempotencyKey = normalizeOptionalString(params.idempotencyKey);
  if (!sourceSessionKey || !targetSessionKey || !targetSessionId || !idempotencyKey) {
    return undefined;
  }
  return {
    sourceSessionKey,
    ...(sourceSessionId ? { sourceSessionId } : {}),
    targetSessionKey,
    targetSessionId,
    idempotencyKey,
  };
}

function pruneExpired(nowMs: number): void {
  for (const [handoffId, entry] of handoffs) {
    if (!isFutureDateTimestampMs(entry.expiresAtMs, { nowMs })) {
      handoffs.delete(handoffId);
    }
  }
}

/** Register one short-lived capability for the exact completion delivery request. */
export function registerSubagentCompletionToolHandoff(
  params: SubagentCompletionToolHandoffRegistration & { nowMs?: number },
): string | undefined {
  const normalized = normalizeRegistration(params);
  if (!normalized) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  pruneExpired(nowMs);
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(SUBAGENT_COMPLETION_TOOL_HANDOFF_TTL_MS, {
    nowMs,
  });
  if (expiresAtMs === undefined) {
    return undefined;
  }
  const handoffId = randomUUID();
  handoffs.set(handoffId, { ...normalized, expiresAtMs });
  return handoffId;
}

/** Remove an unconsumed capability after its in-process dispatch finishes or fails. */
export function cancelSubagentCompletionToolHandoff(handoffId: string | undefined): boolean {
  const normalized = normalizeOptionalString(handoffId);
  return normalized ? handoffs.delete(normalized) : false;
}

/**
 * Consume the capability once and bind it to the model route admitted for this run.
 * Mismatches do not burn the capability; only the exact request may consume it.
 */
export function consumeSubagentCompletionToolHandoff(params: {
  handoffId?: string;
  sourceSessionKey?: string;
  sourceSessionId?: string;
  targetSessionKey?: string;
  targetSessionId?: string;
  idempotencyKey?: string;
  provider?: string;
  model?: string;
  nowMs?: number;
}): TrustedSubagentCompletionHandoff | undefined {
  const handoffId = normalizeOptionalString(params.handoffId);
  const sourceSessionKey = normalizeOptionalString(params.sourceSessionKey);
  const sourceSessionId = normalizeOptionalString(params.sourceSessionId);
  const targetSessionKey = normalizeOptionalString(params.targetSessionKey);
  const targetSessionId = normalizeOptionalString(params.targetSessionId);
  const idempotencyKey = normalizeOptionalString(params.idempotencyKey);
  const provider = normalizeOptionalString(params.provider)?.toLowerCase();
  const model = normalizeOptionalString(params.model);
  if (
    !handoffId ||
    !sourceSessionKey ||
    !targetSessionKey ||
    !targetSessionId ||
    !idempotencyKey ||
    !provider ||
    !model
  ) {
    return undefined;
  }
  const nowMs = params.nowMs ?? Date.now();
  pruneExpired(nowMs);
  const entry = handoffs.get(handoffId);
  if (
    !entry ||
    entry.sourceSessionKey !== sourceSessionKey ||
    entry.sourceSessionId !== sourceSessionId ||
    entry.targetSessionKey !== targetSessionKey ||
    entry.targetSessionId !== targetSessionId ||
    entry.idempotencyKey !== idempotencyKey
  ) {
    return undefined;
  }
  handoffs.delete(handoffId);
  return {
    kind: "subagent-completion",
    sourceSessionKey,
    ...(sourceSessionId ? { sourceSessionId } : {}),
    targetSessionKey,
    targetSessionId,
    provider,
    model,
  };
}
