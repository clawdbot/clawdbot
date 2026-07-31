// Prepares parent-context fork metadata for guarded reply session initialization.
import { buildMainSessionRecoveryClearPatch } from "../../agents/main-session-recovery-clear.js";
import type { SessionEntry } from "../../config/sessions.js";
import { forkSessionFromParent, resolveParentForkDecision } from "./session-fork.js";

export async function prepareReplySessionParentFork(params: {
  agentId: string;
  alreadyForked: boolean;
  parentSessionKey?: string;
  readEntry: (sessionKey: string) => SessionEntry | undefined;
  sessionEntry: SessionEntry;
  sessionKey: string;
  storePath: string;
  warn: (message: string) => void;
}): Promise<SessionEntry> {
  if (
    !params.parentSessionKey ||
    params.parentSessionKey === params.sessionKey ||
    params.alreadyForked
  ) {
    return params.sessionEntry;
  }
  const parentEntry = params.readEntry(params.parentSessionKey);
  if (!parentEntry?.sessionId) {
    return params.sessionEntry;
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
    return { ...params.sessionEntry, forkedFromParent: true };
  }
  const fork = await forkSessionFromParent({
    parentEntry,
    agentId: params.agentId,
    parentSessionKey: params.parentSessionKey,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  if (!fork) {
    return params.sessionEntry;
  }
  params.warn(
    `forking from parent session: parentKey=${params.parentSessionKey} → sessionKey=${params.sessionKey} ` +
      `parentTokens=${decision.parentTokens ?? "unknown"}`,
  );
  // The fork replaces this thread's transcript identity; recovery state from
  // the preseed row must not govern a later interruption of the fork.
  return {
    ...params.sessionEntry,
    ...buildMainSessionRecoveryClearPatch(params.sessionEntry),
    sessionId: fork.sessionId,
    forkSource: {
      sessionKey: params.parentSessionKey,
      sessionId: parentEntry.sessionId,
    },
    forkedFromParent: true,
    totalTokens: undefined,
    totalTokensFresh: false,
  };
}
