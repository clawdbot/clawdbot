/** In-memory spoken confirmation binding for high-impact Talk actions. */
import { createHash, randomUUID } from "node:crypto";
import { buildToolMutationState } from "../agents/tool-mutation.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";

const CONFIRMATION_TTL_MS = 2 * 60_000;

type PendingVoiceConfirmation = {
  confirmationId: string;
  runId?: string;
  fingerprint: string;
  createdAt: number;
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

type ConfirmationScopeState = {
  pending?: PendingVoiceConfirmation;
  recentUtterance?: RecentVoiceUserUtterance;
  approvedByRun: Map<string, Map<string, number>>;
  pendingExpiryTimer?: ReturnType<typeof setTimeout>;
};

const confirmationScopes = new Map<string, ConfirmationScopeState>();

function confirmationScopeKey(agentId: string, voiceSessionId: string): string {
  return `${agentId}\0${voiceSessionId}`;
}

function clearPendingExpiryTimer(state: ConfirmationScopeState): void {
  if (!state.pendingExpiryTimer) {
    return;
  }
  clearTimeout(state.pendingExpiryTimer);
  delete state.pendingExpiryTimer;
}

function clearPendingConfirmation(state: ConfirmationScopeState): void {
  clearPendingExpiryTimer(state);
  delete state.pending;
  delete state.recentUtterance;
}

function cleanupConfirmationScope(scopeKey: string, state: ConfirmationScopeState): void {
  if (state.pending || state.recentUtterance || state.approvedByRun.size > 0) {
    return;
  }
  if (confirmationScopes.get(scopeKey) === state) {
    confirmationScopes.delete(scopeKey);
  }
}

function pruneExpiredPendingConfirmation(
  scopeKey: string,
  state: ConfirmationScopeState,
  now: number,
): void {
  if (state.pending && state.pending.expiresAt < now) {
    clearPendingConfirmation(state);
  }
  cleanupConfirmationScope(scopeKey, state);
}

function schedulePendingConfirmationExpiry(
  scopeKey: string,
  state: ConfirmationScopeState,
  now: number,
): void {
  const pending = state.pending;
  if (!pending) {
    clearPendingExpiryTimer(state);
    cleanupConfirmationScope(scopeKey, state);
    return;
  }
  clearPendingExpiryTimer(state);
  // The scope owns one current challenge and one timer. Supersession cancels
  // both together, while expiry remains inclusive at expiresAt.
  state.pendingExpiryTimer = setTimeout(
    () => {
      delete state.pendingExpiryTimer;
      if (confirmationScopes.get(scopeKey) !== state || state.pending !== pending) {
        return;
      }
      const current = Date.now();
      if (pending.expiresAt < current) {
        clearPendingConfirmation(state);
        cleanupConfirmationScope(scopeKey, state);
      } else {
        schedulePendingConfirmationExpiry(scopeKey, state, current);
      }
    },
    Math.max(1, pending.expiresAt - now + 1),
  );
  state.pendingExpiryTimer.unref?.();
}

function getPrunedConfirmationScope(
  scopeKey: string,
  now: number,
): ConfirmationScopeState | undefined {
  const state = confirmationScopes.get(scopeKey);
  if (!state) {
    return undefined;
  }
  pruneExpiredPendingConfirmation(scopeKey, state, now);
  return confirmationScopes.get(scopeKey);
}

function getOrCreateConfirmationScope(scopeKey: string): ConfirmationScopeState {
  const existing = confirmationScopes.get(scopeKey);
  if (existing) {
    return existing;
  }
  const state: ConfirmationScopeState = { approvedByRun: new Map() };
  confirmationScopes.set(scopeKey, state);
  return state;
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
    [
      "message",
      "gateway",
      "nodes",
      "browser",
      "computer",
      "mobile_ui",
      "canvas",
      AUTOMATIONS_TOOL_NAME,
      "process",
    ].includes(normalizedTool)
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

function resolveApprovedFingerprint(
  scopeKey: string,
  runId: string | undefined,
  fingerprint: string,
  now: number,
  consume: boolean,
): boolean {
  if (!runId) {
    return false;
  }
  const state = confirmationScopes.get(scopeKey);
  const approved = state?.approvedByRun.get(runId);
  const expiresAt = approved?.get(fingerprint);
  if (!expiresAt || expiresAt < now) {
    approved?.delete(fingerprint);
    if (approved?.size === 0) {
      state?.approvedByRun.delete(runId);
    }
    if (state) {
      cleanupConfirmationScope(scopeKey, state);
    }
    return false;
  }
  if (consume) {
    approved?.delete(fingerprint);
    if (approved?.size === 0) {
      state?.approvedByRun.delete(runId);
    }
    if (state) {
      cleanupConfirmationScope(scopeKey, state);
    }
  }
  return true;
}

/** Record a finalized user utterance after the durable transcript append succeeds. */
export function noteClientVoiceConfirmationUtterance(params: {
  agentId: string;
  voiceSessionId: string;
  text: string;
  timestamp: number;
}): void {
  const scopeKey = confirmationScopeKey(params.agentId, params.voiceSessionId);
  const state = getPrunedConfirmationScope(scopeKey, params.timestamp);
  if (!state?.pending) {
    return;
  }
  // A spoken refusal kills the outstanding challenge: a later unrelated "yes"
  // must not resurrect an action the user already declined.
  if (
    REFUSAL_PATTERN.test(normalizeUtterance(params.text)) &&
    state.pending.createdAt < params.timestamp
  ) {
    clearPendingConfirmation(state);
    cleanupConfirmationScope(scopeKey, state);
    return;
  }
  state.recentUtterance = { text: params.text, timestamp: params.timestamp };
}

type ClientVoiceToolConfirmationPolicyParams = {
  agentId?: string;
  voiceSessionId?: string;
  runId?: string;
  toolName: string;
  toolParams: unknown;
  isConfirmable?: () => boolean;
  now?: number;
};

type ClientVoiceToolConfirmationPolicyResult =
  | { allowed: true }
  | { allowed: false; reason: string };

function resolveClientVoiceToolConfirmationPolicy(
  params: ClientVoiceToolConfirmationPolicyParams,
  consume: boolean,
): ClientVoiceToolConfirmationPolicyResult {
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
  if (resolveApprovedFingerprint(scopeKey, params.runId, fingerprint, now, consume)) {
    return { allowed: true };
  }
  const state = getPrunedConfirmationScope(scopeKey, now) ?? getOrCreateConfirmationScope(scopeKey);
  const pending = state.pending;
  const existing =
    pending && pending.runId === params.runId && pending.fingerprint === fingerprint
      ? pending
      : undefined;
  if (!existing) {
    clearPendingConfirmation(state);
  }
  const confirmation =
    existing ??
    ({
      confirmationId: randomUUID(),
      ...(params.runId ? { runId: params.runId } : {}),
      fingerprint,
      createdAt: now,
      expiresAt: now + CONFIRMATION_TTL_MS,
    } satisfies PendingVoiceConfirmation);
  state.pending = confirmation;
  schedulePendingConfirmationExpiry(scopeKey, state, now);
  return {
    allowed: false,
    reason:
      `VOICE_CONFIRMATION_REQUIRED:${confirmation.confirmationId} ` +
      `The high-impact voice action "${params.toolName}" was not executed. ` +
      "Ask the user for explicit spoken confirmation, then call openclaw_agent_consult again with this confirmationId.",
  };
}

/** Check whether one exact high-impact action is approved without consuming its grant. */
export function checkClientVoiceToolConfirmationPolicy(
  params: ClientVoiceToolConfirmationPolicyParams,
): ClientVoiceToolConfirmationPolicyResult {
  return resolveClientVoiceToolConfirmationPolicy(params, false);
}

/** Authorize the canonical execution params and consume their one-shot grant. */
export function consumeClientVoiceToolConfirmationPolicy(
  params: ClientVoiceToolConfirmationPolicyParams,
): ClientVoiceToolConfirmationPolicyResult {
  return resolveClientVoiceToolConfirmationPolicy(params, true);
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
  const now = params.now ?? Date.now();
  const scopeKey = confirmationScopeKey(params.agentId, params.voiceSessionId);
  const state = getPrunedConfirmationScope(scopeKey, now);
  const confirmation = state?.pending;
  if (!confirmation) {
    throw new Error("voice confirmation is missing, expired, or belongs to another action");
  }
  // A bare "yes" can only answer the question the model asked last; authorizing an
  // older challenge would let the model swap in a different pending action.
  if (confirmation.confirmationId !== params.confirmationId) {
    throw new Error("a newer confirmation request supersedes this one; ask again");
  }
  const affirmation = state.recentUtterance;
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

/**
 * Bind a validated spoken grant to the one follow-up run and consume the
 * challenge. Invalidated detached grants return false without disrupting the
 * admitted run; final tool policy then blocks because no approval was created.
 */
export function bindAuthorizedClientVoiceConfirmation(params: {
  grant: ClientVoiceConfirmationGrant;
  runId: string;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  const scopeKey = confirmationScopeKey(params.grant.agentId, params.grant.voiceSessionId);
  const state = confirmationScopes.get(scopeKey);
  const pending = state?.pending;
  if (
    !state ||
    !pending ||
    pending.expiresAt < now ||
    pending.confirmationId !== params.grant.confirmationId ||
    pending.fingerprint !== params.grant.fingerprint ||
    pending.expiresAt !== params.grant.expiresAt
  ) {
    return false;
  }
  const approved = state.approvedByRun.get(params.runId) ?? new Map<string, number>();
  approved.set(pending.fingerprint, pending.expiresAt);
  state.approvedByRun.set(params.runId, approved);
  // Consume now that the run exists: one spoken affirmation authorizes one action.
  clearPendingConfirmation(state);
  cleanupConfirmationScope(scopeKey, state);
  return true;
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
  const state = confirmationScopes.get(scopeKey);
  if (!state) {
    return;
  }
  clearPendingConfirmation(state);
  const live = new Set(liveRunIds);
  for (const runId of state.approvedByRun.keys()) {
    if (!live.has(runId)) {
      state.approvedByRun.delete(runId);
    }
  }
  cleanupConfirmationScope(scopeKey, state);
}

/** Drop a completed run's surviving grants once its lifecycle ends. */
export function releaseClientVoiceConfirmationRun(
  agentId: string,
  voiceSessionId: string,
  runId: string,
): void {
  const scopeKey = confirmationScopeKey(agentId, voiceSessionId);
  const state = confirmationScopes.get(scopeKey);
  if (!state) {
    return;
  }
  state.approvedByRun.delete(runId);
  cleanupConfirmationScope(scopeKey, state);
}

/** Test-only reset for process-global state. */
function resetClientVoiceConfirmationStateForTest(): void {
  for (const state of confirmationScopes.values()) {
    clearPendingExpiryTimer(state);
  }
  confirmationScopes.clear();
}

function snapshotClientVoiceConfirmationStateForTest() {
  const snapshot = {
    scopeOwners: confirmationScopes.size,
    pendingChallenges: 0,
    recentUtterances: 0,
    approvedRuns: 0,
    approvedGrants: 0,
    expiryOwners: 0,
  };
  for (const state of confirmationScopes.values()) {
    snapshot.pendingChallenges += state.pending ? 1 : 0;
    snapshot.recentUtterances += state.recentUtterance ? 1 : 0;
    snapshot.approvedRuns += state.approvedByRun.size;
    for (const approved of state.approvedByRun.values()) {
      snapshot.approvedGrants += approved.size;
    }
    snapshot.expiryOwners += state.pendingExpiryTimer ? 1 : 0;
  }
  return snapshot;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.clientVoiceConfirmationTestApi")
  ] = {
    resetClientVoiceConfirmationStateForTest,
    snapshotClientVoiceConfirmationStateForTest,
  };
}
