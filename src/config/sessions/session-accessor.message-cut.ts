import {
  forkSqliteSessionAtMessage,
  listSqliteSessionBranches,
  resolveSessionTranscriptActiveLeafEntryId as resolveSqliteSessionTranscriptActiveLeafEntryId,
  rewindSqliteSessionToMessage,
  switchSqliteSessionBranch,
} from "./session-accessor.sqlite-message-cut.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import type {
  SessionBranchListParams,
  SessionBranchListResult,
  SessionBranchSwitchMutationParams,
  SessionBranchSwitchMutationResult,
  SessionMessageCutMutationParams,
  SessionMessageCutMutationResult,
} from "./session-accessor.types.js";

export async function listSessionBranches(
  params: SessionBranchListParams,
): Promise<SessionBranchListResult> {
  return await listSqliteSessionBranches(params);
}

export function resolveSessionTranscriptActiveLeafEntryId(
  events: readonly TranscriptEvent[],
): string | undefined {
  return resolveSqliteSessionTranscriptActiveLeafEntryId(events);
}

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
