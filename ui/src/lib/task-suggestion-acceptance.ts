import type { TaskSuggestionsAcceptParams } from "../../../packages/gateway-protocol/src/index.js";

export type TaskSuggestionAcceptMode = NonNullable<TaskSuggestionsAcceptParams["mode"]>;

export function taskSuggestionAcceptParams(
  taskId: string,
  mode: TaskSuggestionAcceptMode,
  cloudProfileId?: string,
): TaskSuggestionsAcceptParams {
  if (mode === "worktree") {
    return { taskId };
  }
  return { taskId, mode, ...(cloudProfileId ? { cloudProfileId } : {}) };
}
