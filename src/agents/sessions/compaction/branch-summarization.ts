import type { Model } from "../../../llm/types.js";
import {
  collectEntriesForBranchSummaryFromBranches,
  generateBranchSummary as generateBranchSummaryCore,
  openClawAgentCoreRuntime,
  prepareBranchEntries,
  type BranchPreparation,
  type BranchSummaryDetails,
  type FileOperations,
} from "../../runtime/index.js";
import type { SessionEntry, ReadonlySessionManager } from "../session-manager.js";

export type { BranchPreparation, BranchSummaryDetails, FileOperations };
export { prepareBranchEntries };

export interface CollectEntriesResult {
  entries: SessionEntry[];
  commonAncestorId: string | null;
}

export interface BranchSummaryResult {
  summary?: string;
  readFiles?: string[];
  modifiedFiles?: string[];
  aborted?: boolean;
  error?: string;
}

export interface GenerateBranchSummaryOptions {
  model: Model;
  apiKey: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  customInstructions?: string;
  replaceInstructions?: boolean;
  reserveTokens?: number;
}

export function collectEntriesForBranchSummary(
  session: ReadonlySessionManager,
  oldLeafId: string | null,
  targetId: string,
): CollectEntriesResult {
  if (!oldLeafId) {
    return { entries: [], commonAncestorId: null };
  }

  const oldBranch = session.getBranch(oldLeafId);
  const targetPath = session.getBranch(targetId);
  return collectEntriesForBranchSummaryFromBranches(oldBranch, targetPath);
}

export async function generateBranchSummary(
  entries: SessionEntry[],
  options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
  const result = await generateBranchSummaryCore(entries, {
    runtime: openClawAgentCoreRuntime,
    ...options,
  });
  if (result.ok) {
    return result.value;
  }
  if (result.error.code === "aborted") {
    return { aborted: true, error: result.error.message };
  }
  return { error: result.error.message };
}
