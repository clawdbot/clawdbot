import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalAgentRuntimeId } from "../agents/agent-runtime-id.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

export const AGENT_HARNESS_SESSION_KEY_PREFIX = "harness:";
export const AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE =
  "Session key namespace is reserved for agent harness-owned sessions.";
export const AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE =
  "Agent harness-owned session identity is locked and cannot be replaced or shared.";
export const AGENT_HARNESS_MODEL_RUN_FORBIDDEN_MESSAGE =
  "Agent harness-owned sessions cannot be used for one-shot model runs.";

function resolveAgentHarnessSessionKeyRest(sessionKey: string): string {
  const trimmed = sessionKey.trim().toLowerCase();
  return parseAgentSessionKey(trimmed)?.rest ?? trimmed;
}

function resolveAgentHarnessSessionKeyOwner(sessionKey: string): string | undefined {
  const rest = resolveAgentHarnessSessionKeyRest(sessionKey);
  if (!rest.startsWith(AGENT_HARNESS_SESSION_KEY_PREFIX)) {
    return undefined;
  }
  const ownerSegment = rest.slice(AGENT_HARNESS_SESSION_KEY_PREFIX.length).split(":", 1)[0];
  return normalizeOptionalAgentRuntimeId(ownerSegment);
}

/** Agent harnesses own this namespace; public session APIs must not create rows in it. */
export function isAgentHarnessSessionKey(sessionKey: string): boolean {
  return resolveAgentHarnessSessionKeyRest(sessionKey).startsWith(AGENT_HARNESS_SESSION_KEY_PREFIX);
}

export function resolveMissingAgentHarnessSessionError(
  sessionKey: string,
  entry: unknown,
): string | undefined {
  return entry === undefined && isAgentHarnessSessionKey(sessionKey)
    ? AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE
    : undefined;
}

/** Missing reserved keys fail closed; pre-feature unlocked collisions stay ordinary. */
export function resolveAgentHarnessSessionContextError(
  sessionKey: string,
  entry: AgentHarnessSessionStoreEntry | undefined,
): string | undefined {
  if (!isAgentHarnessSessionKey(sessionKey)) {
    return undefined;
  }
  return entry
    ? resolveAgentHarnessSessionStoreEntryError(sessionKey, entry)
    : AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE;
}

/** Trusted creation must bind the namespace owner to the persisted harness owner. */
export function isAgentHarnessSessionKeyOwnedBy(
  sessionKey: string,
  agentHarnessId: unknown,
): boolean {
  const normalizedHarnessId = normalizeOptionalAgentRuntimeId(agentHarnessId);
  return Boolean(
    normalizedHarnessId && normalizedHarnessId === resolveAgentHarnessSessionKeyOwner(sessionKey),
  );
}

type AgentHarnessSessionStoreEntry = {
  agentHarnessId?: unknown;
  modelSelectionLocked?: unknown;
  sessionId?: unknown;
};

/** True when a reserved-looking row carries the durable harness lock added with this feature. */
export function isAgentHarnessSessionStoreEntryProtected(
  sessionKey: string,
  entry: AgentHarnessSessionStoreEntry,
): boolean {
  return isAgentHarnessSessionKey(sessionKey) && entry.modelSelectionLocked === true;
}

/** Validates durable harness locks and prevents transcript identity aliases. */
export function resolveAgentHarnessSessionStoreError(
  store: Record<string, AgentHarnessSessionStoreEntry>,
): string | undefined {
  const lockedSessionIds = new Map<string, string>();
  for (const [sessionKey, entry] of Object.entries(store)) {
    const entryError = resolveAgentHarnessSessionStoreEntryError(sessionKey, entry);
    if (entryError) {
      return entryError;
    }
    if (!isValidAgentHarnessSessionStoreEntry(sessionKey, entry)) {
      continue;
    }
    const sessionId = normalizeOptionalString(entry.sessionId);
    if (!sessionId || lockedSessionIds.has(sessionId)) {
      return AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE;
    }
    lockedSessionIds.set(sessionId, sessionKey);
  }
  for (const [sessionKey, entry] of Object.entries(store)) {
    const sessionId = normalizeOptionalString(entry.sessionId);
    const lockedOwner = sessionId ? lockedSessionIds.get(sessionId) : undefined;
    if (lockedOwner && lockedOwner !== sessionKey) {
      return AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE;
    }
  }
  return undefined;
}

/** Rejects caller-selected transcript identities that would rotate a durable harness lock. */
export function resolveAgentHarnessSessionIdMismatchError(
  entry: AgentHarnessSessionStoreEntry | undefined,
  requestedSessionId: unknown,
): string | undefined {
  if (
    !entry ||
    entry.modelSelectionLocked !== true ||
    !normalizeOptionalAgentRuntimeId(entry.agentHarnessId)
  ) {
    return undefined;
  }
  const requested = normalizeOptionalString(requestedSessionId);
  if (!requested) {
    return undefined;
  }
  return requested === normalizeOptionalString(entry.sessionId)
    ? undefined
    : AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE;
}

/** Locked rows require durable identity; reserved rows must also match the key owner. */
export function resolveAgentHarnessSessionStoreEntryError(
  sessionKey: string,
  entry: AgentHarnessSessionStoreEntry,
): string | undefined {
  if (entry.modelSelectionLocked !== true) {
    return undefined;
  }
  const rawHarnessId = normalizeOptionalString(entry.agentHarnessId)?.toLowerCase();
  const hasCanonicalHarnessOwner =
    Boolean(rawHarnessId) && rawHarnessId === normalizeOptionalAgentRuntimeId(rawHarnessId);
  if (
    !normalizeOptionalString(entry.sessionId) &&
    (isAgentHarnessSessionKey(sessionKey) || entry.agentHarnessId !== undefined)
  ) {
    return AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE;
  }
  if (isAgentHarnessSessionKey(sessionKey)) {
    return hasCanonicalHarnessOwner &&
      isAgentHarnessSessionKeyOwnedBy(sessionKey, entry.agentHarnessId)
      ? undefined
      : AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE;
  }
  // modelSelectionLocked predates harness-owned sessions and still protects
  // ordinary UI sessions. Only rows with an explicit harness owner opt into
  // the stronger transcript identity invariant.
  if (entry.agentHarnessId === undefined) {
    return undefined;
  }
  if (!hasCanonicalHarnessOwner) {
    return AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE;
  }
  return undefined;
}

/** True for any valid durable harness lock, including supported ordinary-key rows. */
export function isValidAgentHarnessSessionStoreEntry(
  sessionKey: string,
  entry: AgentHarnessSessionStoreEntry,
): boolean {
  return (
    entry.modelSelectionLocked === true &&
    (isAgentHarnessSessionKey(sessionKey) ||
      normalizeOptionalAgentRuntimeId(entry.agentHarnessId) !== undefined) &&
    resolveAgentHarnessSessionStoreEntryError(sessionKey, entry) === undefined
  );
}
