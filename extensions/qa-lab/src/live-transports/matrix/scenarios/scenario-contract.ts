// QA Lab Matrix scenarios share room keys and execution contracts with the live adapter.
import {
  findMatrixQaProvisionedRoom,
  type MatrixQaProvisionedTopology,
} from "../substrate/topology.js";

export type MatrixQaE2eeScenarioId = `matrix-e2ee-${string}`;

export const MATRIX_QA_BLOCK_ROOM_KEY = "block";
export const MATRIX_QA_BOT_DM_ROOM_KEY = "bot-dm";
export const MATRIX_QA_DRIVER_DM_ROOM_KEY = "driver-dm";
export const MATRIX_QA_DRIVER_DM_SHARED_ROOM_KEY = "driver-dm-shared";
const MATRIX_QA_E2EE_ROOM_KEY = "e2ee";
export const MATRIX_QA_E2EE_VERIFICATION_DM_ROOM_KEY = "e2ee-verification-dm";
export const MATRIX_QA_HOMESERVER_ROOM_KEY = "homeserver";
export const MATRIX_QA_MEDIA_ROOM_KEY = "media";
export const MATRIX_QA_MEMBERSHIP_ROOM_KEY = "membership";
export const MATRIX_QA_RESTART_ROOM_KEY = "restart";
export const MATRIX_QA_SECONDARY_ROOM_KEY = "secondary";
export const MATRIX_QA_STALE_SYNC_ROOM_KEY = "stale-sync";

export function buildMatrixQaE2eeScenarioRoomKey(scenarioId: MatrixQaE2eeScenarioId) {
  const suffix = scenarioId.replace(/^matrix-e2ee-/, "").replace(/[^A-Za-z0-9_-]/g, "-");
  return `${MATRIX_QA_E2EE_ROOM_KEY}-${suffix}`;
}

export function resolveMatrixQaScenarioRoomId(
  context: Pick<{ roomId: string; topology: MatrixQaProvisionedTopology }, "roomId" | "topology">,
  roomKey?: string,
) {
  return roomKey ? findMatrixQaProvisionedRoom(context.topology, roomKey).roomId : context.roomId;
}
