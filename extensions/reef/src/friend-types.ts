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

export const ReefPeerIdentitySchema = ReefPeerTrustSchema.pick({
  ed25519PublicKey: true,
  x25519PublicKey: true,
  keyEpoch: true,
});

export type ReefAutonomy = z.infer<typeof ReefAutonomySchema>;
export type ReefPeerIdentity = z.infer<typeof ReefPeerIdentitySchema>;
export type ReefPeerTrust = z.infer<typeof ReefPeerTrustSchema>;

export function reefPeerIdentity(trust: ReefPeerTrust): ReefPeerIdentity {
  return ReefPeerIdentitySchema.parse({
    ed25519PublicKey: trust.ed25519PublicKey,
    x25519PublicKey: trust.x25519PublicKey,
    keyEpoch: trust.keyEpoch,
  });
}

export function sameReefPeerIdentity(left: ReefPeerIdentity, right: ReefPeerIdentity): boolean {
  return (
    left.keyEpoch === right.keyEpoch &&
    left.ed25519PublicKey === right.ed25519PublicKey &&
    left.x25519PublicKey === right.x25519PublicKey
  );
}

export function matchesReefPeerIdentity(
  current: ReefPeerTrust | undefined,
  expected: ReefPeerIdentity,
): boolean {
  return Boolean(
    current && !current.safetyNumberChanged && sameReefPeerIdentity(current, expected),
  );
}
