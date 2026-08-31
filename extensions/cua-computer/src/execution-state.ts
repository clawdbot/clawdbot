import type { CuaExecutionResources } from "./execution-resources.js";
import type { CuaRecordingState } from "./recording-actions.js";

export type CuaExecutionState = {
  resources: CuaExecutionResources;
  recording: CuaRecordingState;
};
