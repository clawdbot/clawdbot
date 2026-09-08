import { z } from "zod";

export const updateRecoverySchema = z.discriminatedUnion("serviceRestartSafe", [
  z.strictObject({
    serviceRestartSafe: z.literal(true),
    packageRollbackVerified: z.literal(true).optional(),
    version: z.string().trim().min(1),
    buildId: z.string().trim().min(1).max(96).optional(),
    service: z.enum(["healthy", "failed"]).optional(),
  }),
  z.strictObject({
    serviceRestartSafe: z.literal(false),
    packageRollbackVerified: z.boolean().optional(),
    reason: z.enum([
      "source-rollback-failed",
      "state-migration-started",
      "manager-unavailable",
      "deps-install-failed",
      "build-failed",
      "rollback-checkout-dirty",
      "runtime-verification-failed",
    ]),
  }),
]);

export type UpdateRecovery = z.infer<typeof updateRecoverySchema>;
