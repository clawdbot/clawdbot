import type { UpdateCheckpointRestorePlanRef } from "./update-checkpoint-plan-ref.js";
import type { UpdateCheckpointReadAccess } from "./update-checkpoint-schema.js";
import type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";
/** Facts required to rebind live lease owners; never a serialized capability. */
export type UpdateCheckpointSharedPublication = UpdateCheckpointReadAccess & {
  planRef: UpdateCheckpointRestorePlanRef;
  recoveryRecord: UpdateRecoveryRecord;
};
