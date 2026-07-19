/** In-memory spoken confirmation binding for high-impact Talk actions. */
import { createHash, randomUUID } from "node:crypto";
import { buildToolMutationState } from "../agents/tool-mutation.js";

const CONFIRMATION_TTL_MS = 2 * 60_000;

type PendingVoiceConfirmation = {
  confirmationId: string;
  agentId: string;
  voiceSessionId: string;
  runId?: string;
  fingerprint: string;
  toolName: string;
  createdAt: number;
  /** Monotonic tiebreaker: same-millisecond challenges must still have one newest. */
  seq: number;
  expiresAt: number;
};

type RecentVoiceUserUtterance = {
  text: string;
  timestamp: number;
};

export type ClientVoiceConfirmationGrant = {
  agentId: string;
  voiceSessionId: string;
  confirmationId: string;
  fingerprint: string;
  expiresAt: number;
};

const pendingConfirmations = new Map<string, PendingVoiceConfirmation>();
let confirmationSeq = 0;
const approvedFingerprints = new Map<string, Map<string, Map<string, number>>>();
const recentUserUtterances = new Map<string, RecentVoiceUserUtterance>();

function confirmationScopeKey(agentId: string, voiceSessionId: string): string {
  return `${agentId}\0${voiceSessionId}`;
}

function stableToolFingerprint(toolName: string, params: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(normalize);
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  };
  return createHash("sha256")
    .update(`${toolName}\0${JSON.stringify(normalize(params))}`)
    .digest("hex");
}

function requiresHighImpactVoiceConfirmation(toolName: string, params: unknown): boolean {
  const normalizedTool = toolName.trim().toLowerCase();
  if (!buildToolMutationState(normalizedTool, params).mutatingAction) {
    return false;
  }
  if (
    ["message", "gateway", "nodes", "browser", "computer", "canvas", "cron", "process"].includes(
      normalizedTool,
    )
  ) {
    return true;
  }
  // Workspace-local edits stay bound to this run. Session delegation is gated because
  // delegated runs leave the voice binding and otherwise bypass spoken confirmation.
  if (
    ["write", "edit", "apply_patch", "create_goal", "update_goal", "get_goal"].includes(
      normalizedTool,
    )
  ) {
    return false;
  }
  return true;
}

function consumeApprovedFingerprint(
  voiceSessionId: string,
  runId: string | undefined,
  fingerprint: string,
  now: number,
): boolean {
  if (!runId) {
    return false;
  }
  const approvedByRun = approvedFingerprints.get(voiceSessionId);
  const approved = approvedByRun?.get(runId);
  const expiresAt = approved?.get(fingerprint);
  if (!expiresAt || expiresAt < now) {
    approved?.delete(fingerprint);
    return false;
  }
  approved?.delete(fingerprint);
  return true;
}

/** Record a finalized user utterance after the durable transcript append succeeds. */
export function noteClientVoiceConfirmationUtterance(params: {
  agentId: string;
  voiceSessionId: string;
  text: string;
  timestamp: number;
}): void {
  recentUserUtterances.set(confirmationScopeKey(params.agentId, params.voiceSessionId), {
    text: params.text,
    timestamp: params.timestamp,
  });
  // A spoken refusal kills the outstanding challenge: a later unrelated "yes"
  // must not resurrect an action the user already declined.
  if (REFUSAL_PATTERN.test(normalizeUtterance(params.text))) {
    for (const [confirmationId, confirmation] of pendingConfirmations) {
      if (
        confirmation.agentId === params.agentId &&
        confirmation.voiceSessionId === params.voiceSessionId &&
        confirmation.createdAt < params.timestamp
      ) {
        pendingConfirmations.delete(confirmationId);
      }
    }
  }
}

/** Pause a high-impact action for one voice-bound run until its exact fingerprint is approved. */
export function resolveClientVoiceToolConfirmationPolicy(params: {
  agentId?: string;
  voiceSessionId?: string;
  runId?: string;
  toolName: string;
  toolParams: unknown;
  isConfirmable?: () => boolean;
  now?: number;
}): { allowed: true } | { allowed: false; reason: string } {
  if (!params.agentId || !params.voiceSessionId) {
    return { allowed: true };
  }
  if (!requiresHighImpactVoiceConfirmation(params.toolName, params.toolParams)) {
    return { allowed: true };
  }
  // Sessions that cannot report spoken approvals (legacy clients without transcript
  // RPCs) keep pre-gate behavior; a pause they can never confirm is a dead end.
  // This is not a client trust boundary: authenticated clients can already run any
  // tool via chat.send. The gate guards against voice-channel misfires only.
  if (params.isConfirmable && !params.isConfirmable()) {
    return { allowed: true };
  }
  const now = params.now ?? Date.now();
  const fingerprint = stableToolFingerprint(params.toolName, params.toolParams);
  const scopeKey = confirmationScopeKey(params.agentId, params.voiceSessionId);
  if (consumeApprovedFingerprint(scopeKey, params.runId, fingerprint, now)) {
    return { allowed: true };
  }
  const existing = [...pendingConfirmations.values()].find(
    (entry) =>
      entry.voiceSessionId === params.voiceSessionId &&
      entry.agentId === params.agentId &&
      entry.runId === params.runId &&
      entry.fingerprint === fingerprint &&
      entry.expiresAt >= now,
  );
  const confirmation =
    existing ??
    ({
      confirmationId: randomUUID(),
      agentId: params.agentId,
      voiceSessionId: params.voiceSessionId,
      ...(params.runId ? { runId: params.runId } : {}),
      fingerprint,
      toolName: params.toolName,
      createdAt: now,
      seq: ++confirmationSeq,
      expiresAt: now + CONFIRMATION_TTL_MS,
    } satisfies PendingVoiceConfirmation);
  pendingConfirmations.set(confirmation.confirmationId, confirmation);
  return {
    allowed: false,
    reason:
      `VOICE_CONFIRMATION_REQUIRED:${confirmation.confirmationId} ` +
      `The high-impact voice action "${params.toolName}" was not executed. ` +
      "Ask the user for explicit spoken confirmation, then call openclaw_agent_consult again with this confirmationId.",
  };
}

const REFUSAL_PATTERN = /\b(no|don't|do not|cancel|stop|never mind)\b/;

function normalizeUtterance(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      // STT commonly emits typographic apostrophes; fold them so "don't" (U+2019)
      // matches the refusal pattern and cannot slip past as a non-refusal.
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[,;:.!?]+/g, "")
      .replace(/\s+/g, " ")
  );
}

function isExplicitAffirmation(text: string): boolean {
  const normalized = normalizeUtterance(text);
  if (REFUSAL_PATTERN.test(normalized)) {
    return false;
  }
  // English-only phrases are an accepted first version; localized matching is follow-up work.
  return /^(yes|yes do it|do it|confirm|confirmed|go ahead|proceed|send it|make the change|restart it)$/.test(
    normalized,
  );
}

/** Bind a later affirmative utterance to one exact paused action. */
export function authorizeClientVoiceConfirmation(params: {
  agentId: string;
  voiceSessionId: string;
  confirmationId: string;
  now?: number;
}): ClientVoiceConfirmationGrant {
  const confirmation = pendingConfirmations.get(params.confirmationId);
  const now = params.now ?? Date.now();
  if (
    !confirmation ||
    confirmation.agentId !== params.agentId ||
    confirmation.voiceSessionId !== params.voiceSessionId ||
    confirmation.expiresAt < now
  ) {
    throw new Error("voice confirmation is missing, expired, or belongs to another action");
  }
  // A bare "yes" can only answer the question the model asked last; authorizing an
  // older challenge would let the model swap in a different pending action.
  for (const entry of pendingConfirmations.values()) {
    if (
      entry.agentId === params.agentId &&
      entry.voiceSessionId === params.voiceSessionId &&
      entry.seq > confirmation.seq
    ) {
      throw new Error("a newer confirmation request supersedes this one; ask again");
    }
  }
  const scopeKey = confirmationScopeKey(params.agentId, params.voiceSessionId);
  const affirmation = recentUserUtterances.get(scopeKey);
  if (
    !affirmation ||
    affirmation.timestamp <= confirmation.createdAt ||
    !isExplicitAffirmation(affirmation.text)
  ) {
    throw new Error("explicit spoken confirmation was not found after the action request");
  }
  // Validate only; the challenge and affirmation are consumed at bind time, once the
  // consult run is established. This keeps a failed/lost-response consult retryable
  // with the same confirmationId instead of leaving the action unconfirmable.
  return {
    agentId: params.agentId,
    voiceSessionId: params.voiceSessionId,
    confirmationId: params.confirmationId,
    fingerprint: confirmation.fingerprint,
    expiresAt: confirmation.expiresAt,
  };
}

/** Bind a validated spoken grant to the one follow-up run and consume the challenge. */
export function bindAuthorizedClientVoiceConfirmation(params: {
  grant: ClientVoiceConfirmationGrant;
  runId: string;
}): void {
  const scopeKey = confirmationScopeKey(params.grant.agentId, params.grant.voiceSessionId);
  const approvedByRun = approvedFingerprints.get(scopeKey) ?? new Map();
  const approved = approvedByRun.get(params.runId) ?? new Map<string, number>();
  approved.set(params.grant.fingerprint, params.grant.expiresAt);
  approvedByRun.set(params.runId, approved);
  approvedFingerprints.set(scopeKey, approvedByRun);
  // Consume now that the run exists: one spoken affirmation authorizes one action.
  pendingConfirmations.delete(params.grant.confirmationId);
  recentUserUtterances.delete(scopeKey);
}

/**
 * Remove ephemeral confirmation state when the logical call closes. Approved
 * grants for still-live consult runs survive: a spoken "yes" followed by hangup
 * must not re-block the confirmed action its run is about to execute.
 */
export function deactivateClientVoiceConfirmationSession(
  agentId: string,
  voiceSessionId: string,
  liveRunIds: readonly string[] = [],
): void {
  const scopeKey = confirmationScopeKey(agentId, voiceSessionId);
  recentUserUtterances.delete(scopeKey);
  const approvedByRun = approvedFingerprints.get(scopeKey);
  if (approvedByRun) {
    const live = new Set(liveRunIds);
    for (const runId of approvedByRun.keys()) {
      if (!live.has(runId)) {
        approvedByRun.delete(runId);
      }
    }
    if (approvedByRun.size === 0) {
      approvedFingerprints.delete(scopeKey);
    }
  }
  for (const [confirmationId, confirmation] of pendingConfirmations) {
    if (confirmation.agentId === agentId && confirmation.voiceSessionId === voiceSessionId) {
      pendingConfirmations.delete(confirmationId);
    }
  }
}

/** Drop a completed run's surviving grants once its lifecycle ends. */
export function releaseClientVoiceConfirmationRun(
  agentId: string,
  voiceSessionId: string,
  runId: string,
): void {
  const scopeKey = confirmationScopeKey(agentId, voiceSessionId);
  const approvedByRun = approvedFingerprints.get(scopeKey);
  if (!approvedByRun) {
    return;
  }
  approvedByRun.delete(runId);
  if (approvedByRun.size === 0) {
    approvedFingerprints.delete(scopeKey);
  }
}

/** Test-only reset for process-global state. */
function resetClientVoiceConfirmationStateForTest(): void {
  pendingConfirmations.clear();
  approvedFingerprints.clear();
  recentUserUtterances.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.clientVoiceConfirmationTestApi")
  ] = { resetClientVoiceConfirmationStateForTest };
}
