import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { setGatewayDedupeEntry } from "./agent-job.js";
import type { GatewayRequestContext } from "./types.js";

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
  agentReplayCapability?: string;
}): void {
  setGatewayDedupeEntries({
    dedupe: params.dedupe,
    keys: params.keys,
    entry: {
      ts: Date.now(),
      ok: true,
      agentReplayCapability: params.agentReplayCapability,
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
