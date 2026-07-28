import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { JsonValue } from "./task-registry.types.js";

export const CONTINUATION_DELEGATE_CONTROLLER_ID = "core/continuation-delegate";
export const CONTINUATION_POST_COMPACTION_CONTROLLER_ID = "core/continuation-post-compaction";

export function isContinuationDelegateFlow(flow: TaskFlowRecord): boolean {
  return (
    flow.syncMode === "managed" &&
    (flow.controllerId === CONTINUATION_DELEGATE_CONTROLLER_ID ||
      flow.controllerId === CONTINUATION_POST_COMPACTION_CONTROLLER_ID)
  );
}

export function hasStoredDelegateAttachmentState(stateJson: JsonValue | null | undefined): boolean {
  return (
    stateJson !== undefined &&
    stateJson !== null &&
    (typeof stateJson !== "object" ||
      Array.isArray(stateJson) ||
      Object.hasOwn(stateJson, "attachments") ||
      Object.hasOwn(stateJson, "attachAs"))
  );
}

export function scrubStoredDelegateAttachmentState(
  stateJson: JsonValue | null | undefined,
): JsonValue | null | undefined {
  if (stateJson === undefined || stateJson === null) {
    return stateJson;
  }
  if (typeof stateJson !== "object" || Array.isArray(stateJson)) {
    return {};
  }
  const scrubbed = { ...stateJson };
  delete scrubbed.attachments;
  delete scrubbed.attachAs;
  return scrubbed;
}
