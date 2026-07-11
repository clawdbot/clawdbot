import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  forkSessionEntryFromParentTarget,
  forkSessionFromParentTranscript,
  type ParentForkedSessionTranscript,
  type SessionParentForkDecision,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isModelSelectionLocked,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

/**
 * Default max parent token count beyond which thread/session parent forking is skipped.
 * This prevents new thread sessions from inheriting near-full parent context.
 * See #26905.
 */
const DEFAULT_PARENT_FORK_MAX_TOKENS = 100_000;
const sessionForkRuntimeLoader = createLazyImportLoader(() => import("./session-fork.runtime.js"));

export const MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE =
  "Model-selection-locked sessions cannot create child sessions from parent context.";

function assertParentSessionForkAllowed(parentEntry: SessionEntry): void {
  // A locked harness owns both the model and transcript lineage. Copying that
  // context into an ordinary child would let the child continue it elsewhere.
  if (isModelSelectionLocked(parentEntry)) {
    throw new ModelSelectionLockedError(MODEL_SELECTION_LOCKED_PARENT_FORK_MESSAGE);
  }
}

export type ParentForkDecision = SessionParentForkDecision;

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
  /** Cross-agent forks land the child transcript beside the child's store. */
  targetStorePath?: string;
};

export type ForkedParentSessionEntry = ParentForkedSessionTranscript;

export type ForkSessionEntryFromParentResult =
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

export type ForkSessionEntryFromParentParams = Omit<ForkSessionFromParentParams, "parentEntry"> & {
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

function loadSessionForkRuntime(): Promise<typeof import("./session-fork.runtime.js")> {
  return sessionForkRuntimeLoader.load();
}

function formatParentForkTooLargeMessage(params: {
  parentTokens: number;
  maxTokens: number;
}): string {
  return (
    `Parent context is too large to fork (${params.parentTokens}/${params.maxTokens} tokens); ` +
    "starting with isolated context instead."
  );
}

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
  const maxTokens = DEFAULT_PARENT_FORK_MAX_TOKENS;
  const parentTokens = await resolveParentForkTokenCount({
    parentEntry: params.parentEntry,
    storePath: resolveParentForkStorePath(params),
  });
  if (typeof parentTokens === "number" && parentTokens > maxTokens) {
    return {
      status: "skip",
      reason: "parent-too-large",
      maxTokens,
      parentTokens,
      message: formatParentForkTooLargeMessage({ parentTokens, maxTokens }),
    };
  }
  return {
    status: "fork",
    maxTokens,
    ...(typeof parentTokens === "number" ? { parentTokens } : {}),
  };
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
    resolveDecision: (parentEntry) =>
      resolveParentForkDecision({
        parentEntry,
        agentId: params.agentId,
        config: params.config,
        storePath,
      }),
    sessionTarget: normalizeForkTarget({
      canonicalKey: params.sessionKey,
      storeKeys: params.sessionStoreKeys,
    }),
    skipForkWhen: params.skipForkWhen,
    skipPatch: params.skipPatch,
    storePath,
  });
}

async function resolveParentForkTokenCount(params: {
  parentEntry: SessionEntry;
  storePath: string;
}): Promise<number | undefined> {
  const runtime = await loadSessionForkRuntime();
  return runtime.resolveParentForkTokenCountRuntime(params);
}
