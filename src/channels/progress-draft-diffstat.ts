import { readCompletedFileMutationDelta } from "../agents/file-mutation-args.js";
import { resolveFileMutationToolName } from "../agents/tool-mutation-names.js";

const MAX_TRACKED_MUTATION_FILES = 256;
const MAX_PENDING_MUTATION_DIFFS = 64;

type PendingMutationDelta = NonNullable<ReturnType<typeof readCompletedFileMutationDelta>>;

export type ChannelProgressDraftDiffStat = Readonly<{
  files: number;
  added: number;
  removed: number;
}>;

export function createProgressDraftDiffStatTracker(params: { canStage: () => boolean }) {
  let hasCommittedDiff = false;
  let mutationFiles = new Set<string>();
  let mutationOverflowFiles = 0;
  let mutationAdded = 0;
  let mutationRemoved = 0;
  let pendingMutationDiffs = new Map<string, PendingMutationDelta>();

  const reset = () => {
    hasCommittedDiff = false;
    mutationFiles = new Set();
    mutationOverflowFiles = 0;
    mutationAdded = 0;
    mutationRemoved = 0;
    pendingMutationDiffs = new Map();
  };

  const stageToolEvent = (payload: {
    toolCallId?: string;
    name?: string;
    phase?: string;
    args?: Record<string, unknown>;
  }) => {
    if (!params.canStage()) {
      return;
    }
    const toolCallId = payload.toolCallId?.trim();
    if (payload.phase !== "start" || !toolCallId || !payload.name || !payload.args) {
      return;
    }
    const kind = resolveFileMutationToolName(payload.name);
    const delta = kind ? readCompletedFileMutationDelta(kind, payload.args) : undefined;
    if (!delta) {
      return;
    }
    if (
      !pendingMutationDiffs.has(toolCallId) &&
      pendingMutationDiffs.size >= MAX_PENDING_MUTATION_DIFFS
    ) {
      return;
    }
    pendingMutationDiffs.set(toolCallId, delta);
  };

  const commitItemEvent = (payload: { toolCallId?: string; phase?: string; status?: string }) => {
    const toolCallId = payload.toolCallId?.trim();
    if (!toolCallId || payload.phase !== "end") {
      return;
    }
    const delta = pendingMutationDiffs.get(toolCallId);
    if (!delta) {
      return;
    }
    pendingMutationDiffs.delete(toolCallId);
    const status = payload.status?.trim().toLowerCase();
    if (status === "failed" || status === "error") {
      return;
    }
    hasCommittedDiff = true;
    mutationAdded += delta.added;
    mutationRemoved += delta.removed;
    for (const file of delta.files) {
      if (mutationFiles.has(file)) {
        continue;
      }
      if (mutationFiles.size < MAX_TRACKED_MUTATION_FILES) {
        mutationFiles.add(file);
        continue;
      }
      // Overflow keeps file-count memory bounded. Repeated paths beyond the
      // tracked window may count again, while line totals remain authoritative.
      mutationOverflowFiles += 1;
    }
  };

  const resolve = (): ChannelProgressDraftDiffStat | undefined =>
    hasCommittedDiff
      ? {
          files: mutationFiles.size + mutationOverflowFiles,
          added: mutationAdded,
          removed: mutationRemoved,
        }
      : undefined;

  return {
    stageToolEvent,
    commitItemEvent,
    resolve,
    reset,
  };
}
