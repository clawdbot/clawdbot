import {
  MATRIX_QA_BOT_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  MATRIX_QA_E2EE_ROOM_KEY,
  MATRIX_QA_MEDIA_ROOM_KEY,
  MATRIX_QA_PROFILE_NAMES,
  MATRIX_QA_MEMBERSHIP_ROOM_KEY,
  MATRIX_QA_SCENARIOS,
  MATRIX_QA_SECONDARY_ROOM_KEY,
  MATRIX_QA_STANDARD_SCENARIO_IDS,
  buildMatrixQaE2eeScenarioRoomKey,
  buildMatrixQaTopologyForScenarios,
  findMatrixQaScenarios,
  resolveMatrixQaScenarioRoomId,
  __matrixQaProfileTesting,
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

export const __testing = {
  MATRIX_QA_BOT_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_ROOM_KEY,
  MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY,
  MATRIX_QA_E2EE_ROOM_KEY,
  MATRIX_QA_MEDIA_ROOM_KEY,
  MATRIX_QA_MEMBERSHIP_ROOM_KEY,
  MATRIX_QA_PROFILE_NAMES,
  MATRIX_QA_SECONDARY_ROOM_KEY,
  MATRIX_QA_STANDARD_SCENARIO_IDS,
  buildMatrixQaE2eeScenarioRoomKey,
  buildMatrixQaTopologyForScenarios,
  buildMatrixReplyDetails,
  buildMatrixReplyArtifact,
  buildMentionPrompt,
  findMatrixQaScenarios,
  getMatrixQaProfileScenarioIds: __matrixQaProfileTesting.getMatrixQaProfileScenarioIds,
  normalizeMatrixQaProfile: __matrixQaProfileTesting.normalizeMatrixQaProfile,
  readMatrixQaSyncCursor,
  resolveMatrixQaScenarioRoomId,
  writeMatrixQaSyncCursor,
};
