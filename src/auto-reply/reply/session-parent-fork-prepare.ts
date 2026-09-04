// Prepares parent-context fork metadata for guarded reply session initialization.
import { buildMainSessionRecoveryClearPatch } from "../../agents/main-session-recovery/main-session-recovery-clear.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions.js";
import {
  isRestartRecoveryTombstone,
  SessionRestartRecoveryTombstoneError,
} from "../../config/sessions/lifecycle.js";
import { sessionEntryForkedFromParent } from "../../config/sessions/session-entry-lineage.js";
import { isModelSelectionLocked } from "../../sessions/model-overrides.js";
import { forkSessionFromParent, resolveParentForkDecision } from "./session-fork.js";

export function canReplaceRestartTombstoneFromParent(params: {
  actorType: "agent" | "human" | "system";
  entry?: SessionEntry;
  hasParentForkSource: boolean;
  hasPluginOwnedBinding?: boolean;
  inboundAccessAuthorized?: boolean;
  inboundEventKind?: string;
  nativeCommandTarget?: string;
  sessionKey?: string;
}): boolean {
  return (
    params.hasParentForkSource &&
    isRestartRecoveryTombstone(params.entry) &&
    !isModelSelectionLocked(params.entry) &&
    !sessionEntryForkedFromParent(params.entry) &&
    params.hasPluginOwnedBinding !== true &&
    params.entry?.pluginOwnerId === undefined &&
    params.inboundAccessAuthorized === true &&
    params.inboundEventKind !== "room_event" &&
    params.actorType === "human" &&
    (params.nativeCommandTarget === undefined || params.nativeCommandTarget === params.sessionKey)
  );
}

function restartTombstoneParentReplacementError(sessionKey: string): Error {
  return new SessionRestartRecoveryTombstoneError(
    `Session "${sessionKey}" ended during restart recovery. Use /new or /reset to start a replacement session.`,
  );
}

export async function prepareReplySessionParentFork(params: {
  agentId: string;
  alreadyForked: boolean;
  parentSessionKey?: string;
  requireParentForkReplacement?: boolean;
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
    if (params.requireParentForkReplacement === true) {
      throw restartTombstoneParentReplacementError(params.sessionKey);
    }
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
    if (params.requireParentForkReplacement === true) {
      throw restartTombstoneParentReplacementError(params.sessionKey);
    }
    return params.sessionEntry;
  }
  params.warn(
    `forking from parent session: parentKey=${params.parentSessionKey} → sessionKey=${params.sessionKey} ` +
      `parentTokens=${decision.parentTokens ?? "unknown"}`,
  );
  // The fork replaces this thread's transcript identity; recovery state from
  // the preseed row must not govern a later interruption of the fork.
  const forkedEntry: InternalSessionEntry = {
    ...params.sessionEntry,
    ...buildMainSessionRecoveryClearPatch(params.sessionEntry),
    sessionId: fork.sessionId,
    lifecycleRunId: undefined,
    lastRunId: undefined,
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
