// ACP Core module implements session identity behavior.
import { normalizeText } from "../normalize-text.js";
import type { SessionAcpIdentity, SessionAcpIdentitySource, SessionAcpMeta } from "../types.js";
import type { AcpRuntimeHandle, AcpRuntimeStatus } from "./types.js";

// ACP session identity merge and extraction helpers for resume-safe runtime state.

/** Normalize a stored identity state value from metadata. */
function normalizeIdentityState(value: unknown): SessionAcpIdentity["state"] | undefined {
  if (value !== "pending" && value !== "resolved") {
    return undefined;
  }
  return value;
}

/** Normalize where an ACP identity observation came from. */
function normalizeIdentitySource(value: unknown): SessionAcpIdentitySource | undefined {
  if (value !== "ensure" && value !== "status" && value !== "event") {
    return undefined;
  }
  return value;
}

/** Normalize an identity object and infer pending/resolved state from stable ids. */
function normalizeIdentity(
  identity: SessionAcpIdentity | undefined,
): SessionAcpIdentity | undefined {
  if (!identity) {
    return undefined;
  }
  const state = normalizeIdentityState(identity.state);
  const source = normalizeIdentitySource(identity.source);
  const acpxRecordId = normalizeText(identity.acpxRecordId);
  const acpxSessionId = normalizeText(identity.acpxSessionId);
  const agentSessionId = normalizeText(identity.agentSessionId);
  const lastUpdatedAt =
    typeof identity.lastUpdatedAt === "number" && Number.isFinite(identity.lastUpdatedAt)
      ? identity.lastUpdatedAt
      : undefined;
  const hasAnyId = Boolean(acpxRecordId || acpxSessionId || agentSessionId);
  if (!state && !source && !hasAnyId && lastUpdatedAt === undefined) {
    return undefined;
  }
  const resolved = Boolean(acpxSessionId || agentSessionId);
  const normalizedState = state ?? (resolved ? "resolved" : "pending");
  return {
    state: normalizedState,
    ...(acpxRecordId ? { acpxRecordId } : {}),
    ...(acpxSessionId ? { acpxSessionId } : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
    source: source ?? "status",
    lastUpdatedAt: lastUpdatedAt ?? Date.now(),
  };
}

type IdentityIds = Pick<SessionAcpIdentity, "acpxRecordId" | "acpxSessionId" | "agentSessionId">;

/** Read identity ids from a runtime handle shape. */
function readIdentityIdsFromHandle(handle: AcpRuntimeHandle): IdentityIds {
  return {
    acpxRecordId: normalizeText((handle as { acpxRecordId?: unknown }).acpxRecordId),
    acpxSessionId: normalizeText(handle.backendSessionId),
    agentSessionId: normalizeText(handle.agentSessionId),
  };
}

/** Build an identity only when at least one stable id is known. */
function buildSessionIdentity(params: {
  ids: IdentityIds;
  state: SessionAcpIdentity["state"];
  source: SessionAcpIdentitySource;
  now: number;
}): SessionAcpIdentity | undefined {
  const { acpxRecordId, acpxSessionId, agentSessionId } = params.ids;
  if (!acpxRecordId && !acpxSessionId && !agentSessionId) {
    return undefined;
  }
  return {
    state: params.state,
    ...(acpxRecordId ? { acpxRecordId } : {}),
    ...(acpxSessionId ? { acpxSessionId } : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
    source: params.source,
    lastUpdatedAt: params.now,
  };
}

/** Resolve normalized ACP identity from persisted session metadata. */
export function resolveSessionIdentityFromMeta(
  meta: SessionAcpMeta | undefined,
): SessionAcpIdentity | undefined {
  if (!meta) {
    return undefined;
  }
  return normalizeIdentity(meta.identity);
}

/** Return true when an identity has a backend or agent session id. */
export function identityHasStableSessionId(identity: SessionAcpIdentity | undefined): boolean {
  return Boolean(identity?.acpxSessionId || identity?.agentSessionId);
}

/** Resolve the runtime resume id, preferring agent session id over ACP backend id. */
export function resolveRuntimeResumeSessionId(
  identity: SessionAcpIdentity | undefined,
): string | undefined {
  if (!identity) {
    return undefined;
  }
  return normalizeText(identity.agentSessionId) ?? normalizeText(identity.acpxSessionId);
}

/** Return true when identity is absent or still pending. */
export function isSessionIdentityPending(identity: SessionAcpIdentity | undefined): boolean {
  if (!identity) {
    return true;
  }
  return identity.state === "pending";
}

/** Compare identities ignoring lastUpdatedAt timestamp churn. */
export function identityEquals(
  left: SessionAcpIdentity | undefined,
  right: SessionAcpIdentity | undefined,
): boolean {
  const a = normalizeIdentity(left);
  const b = normalizeIdentity(right);
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.state === b.state &&
    a.acpxRecordId === b.acpxRecordId &&
    a.acpxSessionId === b.acpxSessionId &&
    a.agentSessionId === b.agentSessionId &&
    a.source === b.source
  );
}

/** Merge current and incoming identity observations without downgrading resolved ids. */
export function mergeSessionIdentity(params: {
  current: SessionAcpIdentity | undefined;
  incoming: SessionAcpIdentity | undefined;
  now: number;
}): SessionAcpIdentity | undefined {
  const current = normalizeIdentity(params.current);
  const incoming = normalizeIdentity(params.incoming);
  if (!current) {
    if (!incoming) {
      return undefined;
    }
    return { ...incoming, lastUpdatedAt: params.now };
  }
  if (!incoming) {
    return current;
  }

  const currentResolved = current.state === "resolved";
  const incomingResolved = incoming.state === "resolved";
  const allowIncomingValue = !currentResolved || incomingResolved;
  const nextRecordId =
    allowIncomingValue && incoming.acpxRecordId ? incoming.acpxRecordId : current.acpxRecordId;
  const nextAcpxSessionId =
    allowIncomingValue && incoming.acpxSessionId ? incoming.acpxSessionId : current.acpxSessionId;
  const nextAgentSessionId =
    allowIncomingValue && incoming.agentSessionId
      ? incoming.agentSessionId
      : current.agentSessionId;

  const nextResolved = Boolean(nextAcpxSessionId || nextAgentSessionId);
  const nextState: SessionAcpIdentity["state"] = nextResolved
    ? "resolved"
    : currentResolved
      ? "resolved"
      : incoming.state;
  const nextSource = allowIncomingValue ? incoming.source : current.source;
  const next: SessionAcpIdentity = {
    state: nextState,
    ...(nextRecordId ? { acpxRecordId: nextRecordId } : {}),
    ...(nextAcpxSessionId ? { acpxSessionId: nextAcpxSessionId } : {}),
    ...(nextAgentSessionId ? { agentSessionId: nextAgentSessionId } : {}),
    source: nextSource,
    lastUpdatedAt: params.now,
  };
  return next;
}

/** Create a pending identity from an ensure-session handle. */
export function createIdentityFromEnsure(params: {
  handle: AcpRuntimeHandle;
  now: number;
}): SessionAcpIdentity | undefined {
  return buildSessionIdentity({
    ids: readIdentityIdsFromHandle(params.handle),
    state: "pending",
    source: "ensure",
    now: params.now,
  });
}

/** Create an identity from a runtime event handle. */
export function createIdentityFromHandleEvent(params: {
  handle: AcpRuntimeHandle;
  now: number;
}): SessionAcpIdentity | undefined {
  const ids = readIdentityIdsFromHandle(params.handle);
  return buildSessionIdentity({
    ids,
    state: ids.agentSessionId ? "resolved" : "pending",
    source: "event",
    now: params.now,
  });
}

/** Create an identity from runtime status output. */
export function createIdentityFromStatus(params: {
  status: AcpRuntimeStatus | undefined;
  now: number;
}): SessionAcpIdentity | undefined {
  if (!params.status) {
    return undefined;
  }
  const details = params.status.details;
  const acpxRecordId =
    normalizeText((params.status as { acpxRecordId?: unknown }).acpxRecordId) ??
    normalizeText(details?.acpxRecordId);
  const acpxSessionId =
    normalizeText(params.status.backendSessionId) ??
    normalizeText(details?.backendSessionId) ??
    normalizeText(details?.acpxSessionId);
  const agentSessionId =
    normalizeText(params.status.agentSessionId) ?? normalizeText(details?.agentSessionId);
  if (!acpxRecordId && !acpxSessionId && !agentSessionId) {
    return undefined;
  }
  const resolved = Boolean(acpxSessionId || agentSessionId);
  return {
    state: resolved ? "resolved" : "pending",
    ...(acpxRecordId ? { acpxRecordId } : {}),
    ...(acpxSessionId ? { acpxSessionId } : {}),
    ...(agentSessionId ? { agentSessionId } : {}),
    source: "status",
    lastUpdatedAt: params.now,
  };
}

/** Convert ACP identity ids into runtime handle resume identifiers. */
export function resolveRuntimeHandleIdentifiersFromIdentity(
  identity: SessionAcpIdentity | undefined,
): { backendSessionId?: string; agentSessionId?: string } {
  if (!identity) {
    return {};
  }
  return {
    ...(identity.acpxSessionId ? { backendSessionId: identity.acpxSessionId } : {}),
    ...(identity.agentSessionId ? { agentSessionId: identity.agentSessionId } : {}),
  };
}
