import {
  forkSqliteSessionAtMessage,
  rewindSqliteSessionToMessage,
  switchSqliteSessionBranch,
} from "./session-accessor.sqlite-message-cut.js";
import type {
  SessionBranchSwitchMutationParams,
  SessionBranchSwitchMutationResult,
  SessionMessageCutMutationParams,
  SessionMessageCutMutationResult,
} from "./session-accessor.types.js";

export {
  listSqliteSessionBranches as listSessionBranches,
  resolveSessionTranscriptActiveLeafEntryId,
} from "./session-accessor.sqlite-message-cut.js";

export async function rewindSessionToMessage(
  params: SessionMessageCutMutationParams,
): Promise<SessionMessageCutMutationResult> {
  const result = await rewindSqliteSessionToMessage(params);
  return result.status === "conflict" ? { status: "failed" } : result;
}

export async function forkSessionAtMessage(
  params: SessionMessageCutMutationParams & { targetKey: string },
): Promise<SessionMessageCutMutationResult> {
  const result = await forkSqliteSessionAtMessage(params);
  return result.status === "conflict" ? { status: "failed" } : result;
}

export async function switchSessionBranch(
  params: SessionBranchSwitchMutationParams,
): Promise<SessionBranchSwitchMutationResult> {
  const result = await switchSqliteSessionBranch(params);
  return result.status === "conflict" ? { status: "failed" } : result;
}
