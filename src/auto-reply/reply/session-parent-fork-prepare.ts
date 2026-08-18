// Prepares parent-context fork metadata for guarded reply session initialization.
import { buildMainSessionRecoveryClearPatch } from "../../agents/main-session-recovery/main-session-recovery-clear.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions.js";
import { isModelSelectionLocked } from "../../sessions/model-overrides.js";
import { forkSessionFromParent, resolveParentForkDecision } from "./session-fork.js";

function withProvisionalParentFork(params: {
  id?: string;
  parentSessionKey?: string;
  sessionEntry: SessionEntry;
}): SessionEntry {
  const id = params.id?.trim();
  if (!id || !params.parentSessionKey) {
    return params.sessionEntry;
  }
  const current = params.sessionEntry.provisionalParentFork;
  if (current?.id === id && current.parentSessionKey === params.parentSessionKey) {
    return params.sessionEntry;
  }
  return {
    ...params.sessionEntry,
    provisionalParentFork: {
      id,
      parentSessionKey: params.parentSessionKey,
      createdAt: Date.now(),
    },
  };
}

export async function prepareReplySessionParentFork(params: {
  agentId: string;
  alreadyForked: boolean;
  parentSessionKey?: string;
  provisionalParentForkOwned: boolean;
  provisionalParentForkId?: string;
  readEntry: (sessionKey: string) => SessionEntry | undefined;
  sessionEntry: SessionEntry;
  sessionKey: string;
  storePath: string;
  warn: (message: string) => void;
}): Promise<SessionEntry> {
  if (params.provisionalParentForkId && !params.provisionalParentForkOwned) {
    // Default inheritance is owned by the inbound event that first materialized
    // this thread row. A delayed bot root must not replace an ordinary thread
    // session that a user already created under the same canonical key.
    params.warn(
      `skipping parent fork (existing child owns session): parentKey=${params.parentSessionKey ?? "unknown"} → sessionKey=${params.sessionKey}`,
    );
    return {
      ...params.sessionEntry,
      provisionalParentFork: undefined,
      forkedFromParent: true,
    };
  }
  const sessionEntry = withProvisionalParentFork({
    id: params.provisionalParentForkId,
    parentSessionKey: params.parentSessionKey,
    sessionEntry: params.sessionEntry,
  });
  if (
    !params.parentSessionKey ||
    params.parentSessionKey === params.sessionKey ||
    params.alreadyForked
  ) {
    return sessionEntry;
  }
  const parentEntry = params.readEntry(params.parentSessionKey);
  if (!parentEntry?.sessionId) {
    return sessionEntry;
  }
  if (isModelSelectionLocked(parentEntry)) {
    // A locked harness owns the parent's model and transcript lineage. Keep the
    // child usable without copying that protected context, and mark the fork
    // decision handled so later turns do not retry it.
    params.warn(
      `skipping parent fork (model selection locked): parentKey=${params.parentSessionKey} → sessionKey=${params.sessionKey}`,
    );
    return { ...sessionEntry, forkedFromParent: true };
  }
  const decision = await resolveParentForkDecision({
    parentEntry,
    agentId: params.agentId,
    storePath: params.storePath,
  });
  if (decision.status === "skip") {
    // The parent branch is too large to inherit usefully. Start fresh and
    // mark as handled so the thread does not retry this decision every turn.
    params.warn(
      `skipping parent fork (parent too large): parentKey=${params.parentSessionKey} → sessionKey=${params.sessionKey} ` +
        `parentTokens=${decision.parentTokens} maxTokens=${decision.maxTokens}`,
    );
    return { ...sessionEntry, forkedFromParent: true };
  }
  const fork = await forkSessionFromParent({
    parentEntry,
    agentId: params.agentId,
    parentSessionKey: params.parentSessionKey,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  if (!fork) {
    return sessionEntry;
  }
  params.warn(
    `forking from parent session: parentKey=${params.parentSessionKey} → sessionKey=${params.sessionKey} ` +
      `parentTokens=${decision.parentTokens ?? "unknown"}`,
  );
  // The fork replaces this thread's transcript identity; recovery state from
  // the preseed row must not govern a later interruption of the fork.
  const forkedEntry: InternalSessionEntry = {
    ...sessionEntry,
    ...buildMainSessionRecoveryClearPatch(sessionEntry),
    sessionId: fork.sessionId,
    lifecycleRunId: undefined,
    forkSource: {
      sessionKey: params.parentSessionKey,
      sessionId: parentEntry.sessionId,
    },
    forkedFromParent: true,
    totalTokens: undefined,
    totalTokensFresh: false,
    totalTokensVersion: undefined,
  };
  return forkedEntry;
}
