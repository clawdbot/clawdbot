import crypto from "node:crypto";
import { z } from "zod";
import type { SessionVisibility } from "../../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

const SessionRecipientAuthorityEpochSchema = z.string().uuid();

export type SessionRecipientAuthority = { state: "bound"; epoch: string } | { state: "absent" };

export const SessionRecipientAuthoritySchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("bound"),
      epoch: SessionRecipientAuthorityEpochSchema,
    })
    .strict(),
  z.object({ state: z.literal("absent") }).strict(),
]);

const ContinuationRecipientAuthorityRecipientSchema = z
  .object({
    sessionKey: z.string().trim().min(1).max(4096),
    authority: SessionRecipientAuthoritySchema,
  })
  .strict();

export const ContinuationRecipientAuthorityBindingSchema = z
  .discriminatedUnion("selection", [
    z
      .object({
        version: z.literal(1),
        selection: z.literal("pending"),
        fanoutMode: z.enum(["tree", "all"]),
      })
      .strict(),
    z
      .object({
        version: z.literal(1),
        selection: z.literal("selected"),
        recipients: z.array(ContinuationRecipientAuthorityRecipientSchema).max(10_000),
      })
      .strict(),
  ])
  .superRefine((binding, ctx) => {
    if (binding.selection !== "selected") {
      return;
    }
    const seen = new Set<string>();
    for (const [index, recipient] of binding.recipients.entries()) {
      if (seen.has(recipient.sessionKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["recipients", index, "sessionKey"],
          message: "duplicate continuation recipient authority session key",
        });
      }
      seen.add(recipient.sessionKey);
    }
  });

export type ContinuationRecipientAuthorityBinding = z.infer<
  typeof ContinuationRecipientAuthorityBindingSchema
>;

export type SessionRecipientAuthorityEpochState =
  | { state: "present"; epoch: string }
  | { state: "missing" }
  | { state: "malformed" };

const SESSION_VISIBILITY_AUTHORITY_RANK = {
  draft: 0,
  "read-only": 1,
  suggest: 2,
  shared: 3,
} satisfies Record<SessionVisibility, number>;

export function createSessionRecipientAuthorityEpoch(): string {
  return crypto.randomUUID();
}

export function readSessionRecipientAuthorityEpoch(
  entry: Pick<SessionEntry, "recipientAuthorityEpoch">,
): SessionRecipientAuthorityEpochState {
  const value: unknown = entry.recipientAuthorityEpoch;
  if (value === undefined) {
    return { state: "missing" };
  }
  const parsed = SessionRecipientAuthorityEpochSchema.safeParse(value);
  return parsed.success ? { state: "present", epoch: parsed.data } : { state: "malformed" };
}

export function sessionRecipientAuthorityMatches(
  authority: SessionRecipientAuthority,
  entry: Pick<SessionEntry, "recipientAuthorityEpoch"> | undefined,
): boolean {
  if (authority.state === "absent") {
    return true;
  }
  if (!entry) {
    return false;
  }
  const current = readSessionRecipientAuthorityEpoch(entry);
  return current.state === "present" && current.epoch === authority.epoch;
}

export function doesSessionVisibilityRestrictRecipientAuthority(
  previous: SessionVisibility,
  next: SessionVisibility,
): boolean {
  return SESSION_VISIBILITY_AUTHORITY_RANK[next] < SESSION_VISIBILITY_AUTHORITY_RANK[previous];
}
