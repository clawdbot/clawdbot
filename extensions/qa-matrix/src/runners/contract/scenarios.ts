import {
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  MATRIX_QA_E2EE_ROOM_KEY,
  MATRIX_QA_MEDIA_ROOM_KEY,
  MATRIX_QA_MEMBERSHIP_ROOM_KEY,
  MATRIX_QA_SCENARIOS,
  MATRIX_QA_SECONDARY_ROOM_KEY,
  MATRIX_QA_STANDARD_SCENARIO_IDS,
  buildMatrixQaE2eeScenarioRoomKey,
  buildMatrixQaTopologyForScenarios,
  findMatrixQaScenarios,
  resolveMatrixQaScenarioRoomId,
  type MatrixQaScenarioDefinition,
  type MatrixQaScenarioId,
} from "./scenario-catalog.js";
import {
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  readMatrixQaSyncCursor,
  runMatrixQaCanary,
  runMatrixQaScenario,
  writeMatrixQaSyncCursor,
  type MatrixQaScenarioContext,
  type MatrixQaSyncState,
} from "./scenario-runtime.js";
import type {
  MatrixQaCanaryArtifact,
  MatrixQaReplyArtifact,
  MatrixQaScenarioArtifacts,
  MatrixQaScenarioExecution,
} from "./scenario-types.js";

export type { MatrixQaScenarioDefinition, MatrixQaScenarioId };
export {
  MATRIX_QA_SCENARIOS,
  MATRIX_QA_STANDARD_SCENARIO_IDS,
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMatrixQaE2eeScenarioRoomKey,
  buildMatrixQaTopologyForScenarios,
  buildMentionPrompt,
  findMatrixQaScenarios,
  resolveMatrixQaScenarioRoomId,
  runMatrixQaCanary,
  runMatrixQaScenario,
};
export type {
  MatrixQaCanaryArtifact,
  MatrixQaReplyArtifact,
  MatrixQaScenarioArtifacts,
  MatrixQaScenarioExecution,
};

export type { MatrixQaScenarioContext, MatrixQaSyncState };

export const __testing = {
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  MATRIX_QA_E2EE_ROOM_KEY,
  MATRIX_QA_MEDIA_ROOM_KEY,
  MATRIX_QA_MEMBERSHIP_ROOM_KEY,
  MATRIX_QA_SECONDARY_ROOM_KEY,
  MATRIX_QA_STANDARD_SCENARIO_IDS,
  buildMatrixQaE2eeScenarioRoomKey,
  buildMatrixQaTopologyForScenarios,
  buildMatrixReplyDetails,
  buildMatrixReplyArtifact,
  buildMentionPrompt,
  findMatrixQaScenarios,
  readMatrixQaSyncCursor,
  resolveMatrixQaScenarioRoomId,
  writeMatrixQaSyncCursor,
};
