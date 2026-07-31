import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  forkSessionEntryFromParentTarget,
  forkSessionFromParentTranscript,
  resolveSessionParentForkDecision,
  type SessionParentForkDecision,
  type ParentForkedSessionTranscript,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isModelSelectionLocked,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";

export const MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE =
  "Model-selection-locked sessions cannot create child sessions from parent context.";

function assertParentSessionForkAllowed(parentEntry: SessionEntry): void {
  // A locked harness owns both the model and transcript lineage. Copying that
  // context into an ordinary child would let the child continue it elsewhere.
  if (isModelSelectionLocked(parentEntry)) {
    throw new ModelSelectionLockedError(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
  }
}

type ParentForkDecision = SessionParentForkDecision;

type ParentForkDecisionParams = {
  parentEntry: SessionEntry;
  agentId?: string;
  config?: OpenClawConfig;
  storePath?: string;
};

type ForkSessionFromParentParams = {
  parentSessionKey: string;
  parentEntry: SessionEntry;
  agentId: string;
  config?: OpenClawConfig;
  sessionKey: string;
  storePath?: string;

  /** Cross-agent forks land the child transcript in the target agent's store. */
  targetStorePath?: string;
};

type ForkedParentSessionEntry = ParentForkedSessionTranscript;

type ForkSessionEntryFromParentResult =
  | {
      status: "forked";
      fork: ForkedParentSessionEntry;
      parentEntry: SessionEntry;
      sessionEntry: SessionEntry;
      decision: Extract<ParentForkDecision, { status: "fork" }>;
    }
  | {
      status: "skipped";
      reason: "existing-entry" | "decision-skip";
      parentEntry?: SessionEntry;
      sessionEntry: SessionEntry;
      decision?: ParentForkDecision;
    }
  | { status: "missing-entry" }
  | { status: "missing-parent" }
  | { status: "failed" };

type ForkSessionEntryFromParentParams = Omit<ForkSessionFromParentParams, "parentEntry"> & {
  parentSessionKey: string;
  parentStoreKeys?: readonly string[];
  sessionKey: string;
  sessionStoreKeys?: readonly string[];
  storePath?: string;
  fallbackEntry?: SessionEntry;
  patch?: (params: {
    entry: SessionEntry;
    parentEntry: SessionEntry;
    fork: ForkedParentSessionEntry;
    decision: Extract<ParentForkDecision, { status: "fork" }>;
  }) => Partial<SessionEntry>;
  skipForkWhen?: (entry: SessionEntry) => boolean;
  skipPatch?: (entry: SessionEntry) => Partial<SessionEntry> | null;
  decisionSkipPatch?: (params: {
    decision: Extract<ParentForkDecision, { status: "skip" }>;
    entry: SessionEntry;
    parentEntry: SessionEntry;
  }) => Partial<SessionEntry> | null;
};

function resolveParentForkStorePath(params: {
  agentId?: string;
  config?: OpenClawConfig;
  storePath?: string;
}): string {
  return (
    params.storePath ?? resolveStorePath(params.config?.session?.store, { agentId: params.agentId })
  );
}

export async function resolveParentForkDecision(
  params: ParentForkDecisionParams,
): Promise<ParentForkDecision> {
  assertParentSessionForkAllowed(params.parentEntry);
  return await resolveSessionParentForkDecision({
    parentEntry: params.parentEntry,
    storePath: resolveParentForkStorePath(params),
  });
}

export async function forkSessionFromParent(
  params: ForkSessionFromParentParams,
): Promise<{ sessionId: string; sessionFile: string } | null> {
  // Keep direct callers fail-closed even if they skipped the normal decision step.
  assertParentSessionForkAllowed(params.parentEntry);
  const storePath = resolveParentForkStorePath(params);
  const fork = await forkSessionFromParentTranscript({
    agentId: params.agentId,
    parentEntry: params.parentEntry,
    parentSessionKey: params.parentSessionKey,
    sessionKey: params.sessionKey,
    storePath,
    ...(params.targetStorePath ? { targetStorePath: params.targetStorePath } : {}),
  });
  return fork.status === "created" ? fork.transcript : null;
}

function normalizeForkTarget(params: { canonicalKey: string; storeKeys?: readonly string[] }): {
  canonicalKey: string;
  storeKeys: string[];
} {
  const keys = new Set<string>();
  const remember = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      keys.add(trimmed);
    }
  };
  remember(params.canonicalKey);
  for (const key of params.storeKeys ?? []) {
    remember(key);
  }
  return { canonicalKey: params.canonicalKey, storeKeys: [...keys] };
}

/**
 * Forks the parent transcript and persists the child session entry through one
 * storage boundary operation.
 */
export async function forkSessionEntryFromParent(
  params: ForkSessionEntryFromParentParams,
): Promise<ForkSessionEntryFromParentResult> {
  const storePath = resolveParentForkStorePath(params);
  return await forkSessionEntryFromParentTarget({
    agentId: params.agentId,
    decisionSkipPatch: params.decisionSkipPatch,
    fallbackEntry: params.fallbackEntry,
    parentTarget: normalizeForkTarget({
      canonicalKey: params.parentSessionKey,
      storeKeys: params.parentStoreKeys,
    }),
    patch: params.patch,
    sessionTarget: normalizeForkTarget({
      canonicalKey: params.sessionKey,
      storeKeys: params.sessionStoreKeys,
    }),
    skipForkWhen: params.skipForkWhen,
    skipPatch: params.skipPatch,
    storePath,
  });
}
