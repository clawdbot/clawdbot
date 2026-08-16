import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions.js";
import {
  consumeSessionWorkAdmissionHandoff,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";

export type ExpectedExistingSessionConstraint = {
  handoffId?: string;
  /** String revision, or null for the explicitly captured initial lifecycle. */
  lifecycleRevision?: string | null;
  sessionId?: string;
};

export class ExpectedExistingSessionChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpectedExistingSessionChangedError";
  }
}

export function resolveExpectedExistingSessionConstraint(params: {
  canUseInternalRuntimeHandoff: boolean;
  expectedExistingSessionId?: unknown;
  internalRuntimeHandoffId?: unknown;
}): { ok: true; constraint?: ExpectedExistingSessionConstraint } | { ok: false; error: string } {
  const sessionId = normalizeOptionalString(params.expectedExistingSessionId);
  if (!sessionId) {
    return { ok: true };
  }
  if (!params.canUseInternalRuntimeHandoff) {
    return {
      ok: false,
      error: "expectedExistingSessionId is reserved for backend callers.",
    };
  }
  const handoffId = normalizeOptionalString(params.internalRuntimeHandoffId);
  return {
    ok: true,
    constraint: { sessionId, ...(handoffId ? { handoffId } : {}) },
  };
}

export function resolveInternalExpectedLifecycleConstraint(params: {
  canUseInternalRuntimeHandoff: boolean;
  expectedRequesterLifecycleRevision?: unknown;
}): { ok: true; lifecycleRevision?: string | null } | { ok: false; error: string } {
  if (params.expectedRequesterLifecycleRevision === undefined) {
    return { ok: true };
  }
  if (!params.canUseInternalRuntimeHandoff) {
    return {
      ok: false,
      error: "expectedRequesterLifecycleRevision is reserved for backend callers.",
    };
  }
  if (params.expectedRequesterLifecycleRevision === null) {
    return { ok: true, lifecycleRevision: null };
  }
  const lifecycleRevision = normalizeOptionalString(params.expectedRequesterLifecycleRevision);
  return lifecycleRevision ? { ok: true, lifecycleRevision } : { ok: true };
}

export function validateExpectedExistingSessionTarget(params: {
  constraint?: ExpectedExistingSessionConstraint;
  requestedSessionId?: string;
  requestedSessionKey?: string;
}): string | undefined {
  if (!params.constraint) {
    return undefined;
  }
  if (!params.requestedSessionKey) {
    return "expectedExistingSessionId requires an explicit session key.";
  }
  if (params.requestedSessionId && params.requestedSessionId !== params.constraint.sessionId) {
    return "conflicting session identity constraints.";
  }
  return undefined;
}

export function assertExpectedExistingSession(params: {
  constraint?: ExpectedExistingSessionConstraint;
  entry?: SessionEntry;
  message: string;
}): void {
  if (params.constraint) {
    if (
      params.constraint.sessionId !== undefined &&
      params.entry?.sessionId !== params.constraint.sessionId
    ) {
      throw new ExpectedExistingSessionChangedError(params.message);
    }
    if (params.constraint.lifecycleRevision !== undefined) {
      if (!params.entry) {
        throw new ExpectedExistingSessionChangedError(params.message);
      }
      const actualLifecycleRevision = params.entry?.lifecycleRevision ?? null;
      if (actualLifecycleRevision !== params.constraint.lifecycleRevision) {
        throw new ExpectedExistingSessionChangedError(params.message);
      }
    }
  }
}

export function consumeExpectedSessionWorkAdmission(params: {
  constraint?: ExpectedExistingSessionConstraint;
  identities: Iterable<string | undefined>;
  onInterrupt: () => void;
  scope: string;
}): SessionWorkAdmissionLease | undefined {
  const handoffId = params.constraint?.handoffId;
  if (!handoffId) {
    return undefined;
  }
  const lease = consumeSessionWorkAdmissionHandoff({
    handoffId,
    scope: params.scope,
    identities: params.identities,
    onInterrupt: params.onInterrupt,
  });
  if (!lease) {
    throw new Error("session work admission handoff is unavailable");
  }
  return lease;
}
