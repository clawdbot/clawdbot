import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
} from "@openclaw/normalization-core/number-coercion";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { DEDUPE_TTL_MS } from "../server-constants.js";
import type { DedupeEntry } from "../server-shared.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import type { GatewayRequestContext } from "./types.js";

type ReservedSubagentDedupeReservation = {
  acceptedAt: number;
  dedupeKeys: string[];
  expiresAtMs: number;
  pluginRuntimeOwnerId: string;
  reservationId: string;
  reservedSubagentClaimToken: string;
  runId: string;
  sessionKey: string;
  status: "accepted";
};

type ReservedSubagentDedupeReservationState = {
  expired: boolean;
  reservation: ReservedSubagentDedupeReservation;
};

const activeReservedSubagentDedupeEntries = new WeakSet<DedupeEntry>();

export function isActiveReservedSubagentDedupeEntry(entry: DedupeEntry): boolean {
  return activeReservedSubagentDedupeEntries.has(entry);
}

export function resolveAgentDedupeKeys(params: {
  idempotencyKey: string;
  execApprovalFollowupApprovalId?: string;
}): string[] {
  const keys = [`agent:${params.idempotencyKey}`];
  const approvalId = params.execApprovalFollowupApprovalId?.trim();
  if (approvalId) {
    keys.push(`agent:exec-approval-followup:${approvalId}`);
  }
  return uniqueStrings(keys);
}

export function readGatewayDedupeEntry(params: {
  dedupe: GatewayRequestContext["dedupe"];
  keys: readonly string[];
}) {
  for (const key of params.keys) {
    const entry = params.dedupe.get(key);
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

export function readReservedSubagentDedupeReservation(
  entry: ReturnType<typeof readGatewayDedupeEntry>,
): ReservedSubagentDedupeReservation | undefined {
  const state = readReservedSubagentDedupeReservationState(entry);
  return state && !state.expired ? state.reservation : undefined;
}

export function readReservedSubagentDedupeReservationState(
  entry: ReturnType<typeof readGatewayDedupeEntry>,
): ReservedSubagentDedupeReservationState | undefined {
  if (!entry?.ok || !entry.payload || typeof entry.payload !== "object") {
    return undefined;
  }
  const payload = entry.payload as Partial<ReservedSubagentDedupeReservation>;
  const expiresAtMs = asDateTimestampMs(payload.expiresAtMs);
  if (
    payload.status === "accepted" &&
    typeof payload.runId === "string" &&
    typeof payload.sessionKey === "string" &&
    typeof payload.pluginRuntimeOwnerId === "string" &&
    typeof payload.reservedSubagentClaimToken === "string" &&
    expiresAtMs !== undefined &&
    payload.reservationId === payload.reservedSubagentClaimToken
  ) {
    const reservation = { ...payload, expiresAtMs } as ReservedSubagentDedupeReservation;
    return {
      expired: !isFutureDateTimestampMs(expiresAtMs, { nowMs: Date.now() }),
      reservation,
    };
  }
  return undefined;
}

export function isReservedSubagentDedupeReservationAuthorized(params: {
  reservation: ReservedSubagentDedupeReservation;
  runId: string;
  sessionKey?: string;
  pluginRuntimeOwnerId?: string;
  claimToken?: string;
}): boolean {
  return (
    params.reservation.runId === params.runId &&
    params.reservation.sessionKey === params.sessionKey &&
    params.reservation.pluginRuntimeOwnerId === params.pluginRuntimeOwnerId &&
    params.reservation.reservedSubagentClaimToken === params.claimToken
  );
}

export function reserveReservedSubagentDedupeEntry(params: {
  dedupe: GatewayRequestContext["dedupe"];
  runId: string;
  sessionKey: string;
  pluginRuntimeOwnerId: string;
  claimToken: string;
}): () => void {
  const keys = resolveAgentDedupeKeys({ idempotencyKey: params.runId });
  if (readGatewayDedupeEntry({ dedupe: params.dedupe, keys })) {
    throw new Error("reserved subagent runId already exists in the Gateway dedupe cache.");
  }
  const acceptedAt = Date.now();
  const entry = {
    ts: acceptedAt,
    ok: true,
    payload: {
      acceptedAt,
      dedupeKeys: keys,
      expiresAtMs: acceptedAt + DEDUPE_TTL_MS,
      pluginRuntimeOwnerId: params.pluginRuntimeOwnerId,
      reservationId: params.claimToken,
      reservedSubagentClaimToken: params.claimToken,
      runId: params.runId,
      sessionKey: params.sessionKey,
      status: "accepted" as const,
    },
  };
  activeReservedSubagentDedupeEntries.add(entry);
  for (const key of keys) {
    params.dedupe.set(key, entry);
  }
  return () => {
    activeReservedSubagentDedupeEntries.delete(entry);
    for (const key of keys) {
      if (params.dedupe.get(key) === entry) {
        params.dedupe.delete(key);
      }
    }
  };
}

export function isAcceptedAgentDedupePayload(payload: unknown): payload is {
  acceptedAt?: unknown;
  agentId?: unknown;
  dedupeKeys?: unknown;
  expiresAtMs?: unknown;
  ownerConnId?: unknown;
  ownerDeviceId?: unknown;
  reservationId?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  status: "accepted";
} {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { status?: unknown }).status === "accepted"
  );
}

function isPreRegistrationAbortedAgentDedupePayload(payload: unknown): payload is {
  agentId?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  status: "timeout";
  stopReason?: unknown;
} {
  const stopReason = (payload as { stopReason?: unknown } | null)?.stopReason;
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { status?: unknown }).status === "timeout" &&
    (stopReason === "rpc" || stopReason === "stop")
  );
}

export function isPreRegistrationAbortedAgentDedupeEntryForSession(params: {
  entry: ReturnType<typeof readGatewayDedupeEntry> | undefined;
  runId: string;
  sessionKey?: string;
  alternateSessionKeys?: Array<string | undefined>;
}): boolean {
  if (!params.entry?.ok || !isPreRegistrationAbortedAgentDedupePayload(params.entry.payload)) {
    return false;
  }
  const payload = params.entry.payload;
  const payloadRunId = typeof payload.runId === "string" ? payload.runId.trim() : "";
  if (payloadRunId && payloadRunId !== params.runId) {
    return false;
  }
  const payloadSessionKey =
    typeof payload.sessionKey === "string" && payload.sessionKey.trim()
      ? payload.sessionKey.trim()
      : undefined;
  const expectedSessionKeys = new Set(
    [params.sessionKey, ...(params.alternateSessionKeys ?? [])].filter((value): value is string =>
      Boolean(value?.trim()),
    ),
  );
  return (
    !payloadSessionKey ||
    expectedSessionKeys.size === 0 ||
    expectedSessionKeys.has(payloadSessionKey)
  );
}

export function setGatewayDedupeEntries(params: {
  dedupe: GatewayRequestContext["dedupe"];
  keys: readonly string[];
  entry: Parameters<typeof setGatewayDedupeEntry>[0]["entry"];
}): void {
  for (const key of params.keys) {
    setGatewayDedupeEntry({
      dedupe: params.dedupe,
      key,
      entry: params.entry,
    });
  }
}

export function setAbortedAgentDedupeEntries(params: {
  dedupe: GatewayRequestContext["dedupe"];
  keys: readonly string[];
  agentId?: string;
  sessionKey?: string;
  runId: string;
  stopReason: string;
}): void {
  setGatewayDedupeEntries({
    dedupe: params.dedupe,
    keys: params.keys,
    entry: {
      ts: Date.now(),
      ok: true,
      payload: {
        runId: params.runId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        status: "timeout" as const,
        summary: "aborted",
        stopReason: params.stopReason,
        timeoutPhase: "queue",
        providerStarted: false,
      },
    },
  });
}
