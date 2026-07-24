import {
  forkSqliteSessionAtMessage,
  listSqliteSessionBranches,
  resolveSessionTranscriptActiveLeafEntryId as resolveSqliteSessionTranscriptActiveLeafEntryId,
  rewindSqliteSessionToMessage,
  switchSqliteSessionBranch,
} from "./session-accessor.sqlite.js";
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
  return await rewindSqliteSessionToMessage(params);
}

export async function forkSessionAtMessage(
  params: SessionMessageCutMutationParams & { targetKey: string },
): Promise<SessionMessageCutMutationResult> {
  return await forkSqliteSessionAtMessage(params);
}

export async function switchSessionBranch(
  params: SessionBranchSwitchMutationParams,
): Promise<SessionBranchSwitchMutationResult> {
  return await switchSqliteSessionBranch(params);
}
