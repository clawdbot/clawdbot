import { z } from "zod";

const identifier = z.string().min(1).max(256);
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const anchor = z.strictObject({ entryId: identifier, seq: sequence });

export const UpdateServingGatewayIdentitySchema = z.strictObject({
  bootId: z.string().min(1).max(96),
  version: identifier,
  buildId: identifier.nullable(),
});

/**
 * Private operational evidence, not public diagnostic JSON or authorization.
 * Reset/rewrite, restart, abort, or a different transaction invalidates it.
 * Finalization must check current lifecycle authority after its last await.
 */
export const UpdateServingReceiptSchema = z
  .strictObject({
    runId: z.uuid(),
    gateway: UpdateServingGatewayIdentitySchema,
    agentId: identifier,
    sessionKey: z.string().min(1).max(512),
    sessionId: identifier,
    agentRunId: z.uuid(),
    transcript: z.strictObject({
      generation: identifier,
      maxSeq: sequence,
      user: anchor,
      assistant: anchor,
    }),
    verifiedAtMs: sequence,
  })
  .refine(
    (receipt) =>
      receipt.transcript.user.seq < receipt.transcript.assistant.seq &&
      receipt.transcript.assistant.seq <= receipt.transcript.maxSeq,
    { message: "Invalid serving transcript sequence" },
  );

export type UpdateServingGatewayIdentity = z.infer<typeof UpdateServingGatewayIdentitySchema>;
export type UpdateServingReceipt = z.infer<typeof UpdateServingReceiptSchema>;

export type UpdateServingVerificationResult =
  | { status: "verified"; receipt: UpdateServingReceipt }
  | {
      status: "failed";
      reason:
        | "invalid-request"
        | "runtime-mismatch"
        | "runtime-changed"
        | "aborted"
        | "turn-failed"
        | "turn-incomplete"
        | "response-mismatch"
        | "persistence-missing"
        | "persistence-changed";
    }
  | {
      status: "unavailable";
      reason:
        | "agent-unavailable"
        | "gateway-unavailable"
        | "identity-unavailable"
        | "persistence-unavailable";
    }
  | { status: "timeout"; reason: "deadline" | "turn-timeout" };
