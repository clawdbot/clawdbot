import { removeInternalSessionEffectsSession } from "../../internal-session-effects.js";
import { shouldSuppressSubagentRecoverySessionEffects } from "./subagent-recovery-state.js";
import { safeRemoveAttachmentsDir } from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export async function retireSupersededSubagentRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  runs: Map<string, SubagentRunRecord>;
  clearPendingLifecycleError: (runId: string) => void;
  persistOrThrow: (...runIds: string[]) => void;
}): Promise<void> {
  if (params.runs.get(params.runId) !== params.entry) {
    return;
  }
  const transcriptTarget = params.entry.execution.transcriptTarget;
  const isCurrent = () => params.runs.get(params.runId) === params.entry;
  const transcriptStillOwned = Array.from(params.runs.values()).some((candidate) => {
    if (candidate === params.entry) {
      return false;
    }
    const candidateTarget = candidate.execution.transcriptTarget;
    return (
      candidateTarget?.sessionId === transcriptTarget?.sessionId &&
      candidateTarget?.sessionKey === transcriptTarget?.sessionKey &&
      candidateTarget?.storePath === transcriptTarget?.storePath
    );
  });
  if (
    transcriptTarget &&
    !transcriptStillOwned &&
    !shouldSuppressSubagentRecoverySessionEffects(params.entry)
  ) {
    await removeInternalSessionEffectsSession(transcriptTarget);
    if (!isCurrent()) {
      return;
    }
  }
  if (params.entry.cleanup === "delete" || !params.entry.retainAttachmentsOnKeep) {
    await safeRemoveAttachmentsDir(params.entry);
  }
  if (!isCurrent()) {
    return;
  }
  params.runs.delete(params.runId);
  try {
    params.persistOrThrow(params.runId);
  } catch (error) {
    params.runs.set(params.runId, params.entry);
    throw error;
  }
  params.clearPendingLifecycleError(params.runId);
}
