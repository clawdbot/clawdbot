import { createHash } from "node:crypto";
import { z } from "zod";

const text = z.string().min(1).max(4096);
const offset = z.number().int().min(0).max(60_000);
// These are recorder data, never the broader userbot command/config DSL.
export const telegramProofPlanSchema = z
  .strictObject({
    claim: z.string().min(1).max(1024),
    actions: z
      .array(
        z.discriminatedUnion("type", [
          z.strictObject({ type: z.literal("send"), atMs: offset, text }),
          z.strictObject({
            type: z.literal("click"),
            atMs: offset,
            messageText: text,
            buttonText: z.string().min(1).max(256),
            timeoutMs: z.number().int().min(1).max(10_000),
          }),
        ]),
      )
      .min(1)
      .max(8),
    modelReplies: z.array(text).max(8),
    settings: z.strictObject({
      streaming: z.enum(["off", "partial", "block"]),
      nativeCommands: z.boolean(),
    }),
    maxDurationMs: z.number().int().min(1000).max(90_000),
    expectations: z.array(z.string().min(1).max(1024)).min(1).max(8),
  })
  .superRefine((plan, context) => {
    if (plan.actions[0]?.type !== "send") {
      context.addIssue({ code: "custom", message: "A proof begins with a tester send." });
    }
    for (const [index, action] of plan.actions.entries()) {
      const previous = plan.actions[index - 1];
      const completeBy = action.atMs + (action.type === "click" ? action.timeoutMs : 0);
      if (completeBy >= plan.maxDurationMs || (previous && action.atMs < previous.atMs)) {
        context.addIssue({
          code: "custom",
          message: "Actions must be ordered inside the recording budget.",
        });
      }
    }
  });
export type TelegramProofPlan = z.infer<typeof telegramProofPlanSchema>;

// Shared wire canonicalization: recursive lexicographic object keys, array order
// unchanged, JSON.stringify string/number encoding, UTF-8, no trailing newline.
function canonicalPlan(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalPlan).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalPlan(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function parseTelegramProofPlan(encoded: string, expectedDigest: string) {
  if (Buffer.byteLength(encoded, "utf8") > 48 * 1024 || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error("Invalid proof plan envelope.");
  }
  const plan = telegramProofPlanSchema.parse(JSON.parse(encoded));
  const digest = createHash("sha256").update(canonicalPlan(plan), "utf8").digest("hex");
  if (digest !== expectedDigest) {
    throw new Error("Proof plan digest mismatch.");
  }
  return plan;
}
