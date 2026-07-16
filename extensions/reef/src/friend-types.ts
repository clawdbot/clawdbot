import { z } from "zod";

const PublicKeySchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/);

export const ReefAutonomySchema = z.enum(["notify-only", "bounded", "extended"]);

export const ReefPeerTrustSchema = z
  .object({
    autonomy: ReefAutonomySchema,
    ed25519PublicKey: PublicKeySchema,
    x25519PublicKey: PublicKeySchema,
    keyEpoch: z.number().int().positive(),
    safetyNumberChanged: z.boolean(),
    approvedAt: z.number().int().nonnegative(),
  })
  .strict();

export type ReefAutonomy = z.infer<typeof ReefAutonomySchema>;
export type ReefPeerTrust = z.infer<typeof ReefPeerTrustSchema>;
