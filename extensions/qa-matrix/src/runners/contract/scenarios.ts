// Qa Matrix plugin module implements scenarios behavior.
import {
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  MATRIX_QA_MEDIA_ROOM_KEY,
  MATRIX_QA_SCENARIOS,
  MATRIX_QA_SECONDARY_ROOM_KEY,
  MATRIX_QA_STANDARD_SCENARIO_IDS,
  buildMatrixQaE2eeScenarioRoomKey,
  buildMatrixQaTopologyForScenarios,
  findMatrixQaScenarios,
  resolveMatrixQaScenarioRoomId,
  matrixQaProfileTesting,
} from "./scenario-catalog.js";
import {
  buildMatrixReplyArtifact,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  runMatrixQaCanary,
  runMatrixQaScenario,
  type MatrixQaScenarioContext,
} from "./scenario-runtime.js";
import type { MatrixQaCanaryArtifact, MatrixQaScenarioArtifacts } from "./scenario-types.js";

export {
  MATRIX_QA_SCENARIOS,
  buildMatrixReplyDetails,
  buildMatrixQaTopologyForScenarios,
  findMatrixQaScenarios,
  runMatrixQaCanary,
  runMatrixQaScenario,
};
export type { MatrixQaCanaryArtifact, MatrixQaScenarioArtifacts };

export type { MatrixQaScenarioContext };

export const testing = {
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  MATRIX_QA_MEDIA_ROOM_KEY,
  MATRIX_QA_SECONDARY_ROOM_KEY,
  MATRIX_QA_STANDARD_SCENARIO_IDS,
  buildMatrixQaE2eeScenarioRoomKey,
  buildMatrixQaTopologyForScenarios,
  buildMatrixReplyDetails,
  buildMatrixReplyArtifact,
  buildMentionPrompt,
  findMatrixQaScenarios,
  getMatrixQaProfileScenarioIds: matrixQaProfileTesting.getMatrixQaProfileScenarioIds,
  normalizeMatrixQaProfile: matrixQaProfileTesting.normalizeMatrixQaProfile,
  resolveMatrixQaScenarioRoomId,
};
