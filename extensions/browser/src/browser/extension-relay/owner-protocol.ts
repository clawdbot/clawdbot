import { z } from "zod";

export const RELAY_OWNER_PATH = "/_openclaw/relay/owner";
export const RELAY_OWNER_LIMIT = 64;
export const RELAY_OPERATION_TTL_MS = 5 * 60_000;

export function relayOwnerResource(port: number, profile: string): string {
  return `${RELAY_OWNER_PATH}?port=${port}&profile=${encodeURIComponent(profile)}`;
}

const id = z.number().int().positive();
const reference = z.string().min(1).max(64);
export const relayOwnerRequest = z.discriminatedUnion("op", [
  z.strictObject({ id, op: z.literal("ready"), timeoutMs: z.number().int().min(0).max(10_000) }),
  z.strictObject({ id, op: z.literal("capture"), targetId: z.string().min(1).max(1024) }),
  z.strictObject({ id, op: z.literal("resolve"), ref: reference }),
  z.strictObject({ id, op: z.literal("release"), ref: reference }),
  z.strictObject({ id, op: z.literal("cdp.open"), ref: reference.optional() }),
  z.strictObject({ id, op: z.literal("ingress.open") }),
  z.strictObject({ id, op: z.literal("stream.close"), stream: id }),
  z.strictObject({ id, op: z.literal("close") }),
]);
export const relayOwnerFrame = z.strictObject({ stream: id, frame: z.string() });
export const relayOwnerReply = z.strictObject({
  id,
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export const relayOwnerStreamClosed = z.strictObject({ stream: id, closed: z.literal(true) });
export const relayOwnerStatus = z.strictObject({
  ready: z.boolean(),
  allowLegacyAuth: z.boolean(),
  identity: z
    .strictObject({
      browserVersion: z.string(),
      userAgent: z.string(),
      extensionVersion: z.string(),
    })
    .nullable(),
  generation: z.number().int().nonnegative(),
});
export type RelayOwnerStatus = z.infer<typeof relayOwnerStatus>;

export const relayOwnerRetired = z.strictObject({ retired: z.literal(true) });
