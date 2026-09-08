import { z } from "zod";
/** Discoverable preparation locator, not a sealed plan or publication authority. */
export const UpdateCheckpointRestorePlanIdentitySchema = z
  .object({
    restoreId: z.string().uuid(),
    checkpointId: z.string().uuid(),
    planPath: z.string(),
  })
  .strict();
export type UpdateCheckpointRestorePlanIdentity = z.infer<
  typeof UpdateCheckpointRestorePlanIdentitySchema
>;
export const UpdateCheckpointRestorePlanRefSchema =
  UpdateCheckpointRestorePlanIdentitySchema.extend({
    planSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict();
export type UpdateCheckpointRestorePlanRef = z.infer<typeof UpdateCheckpointRestorePlanRefSchema>;
