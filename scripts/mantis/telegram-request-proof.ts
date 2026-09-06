import { createHash } from "node:crypto";
import { z } from "zod";
import { parseTelegramProofPlan, telegramProofPlanSchema } from "./telegram-proof-plan.ts";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const messageId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const telegramProofIdentitySchema = z
  .strictObject({
    request_id: digest,
    plan_sha256: digest,
    repository: z.strictObject({ id: messageId, full_name: z.literal("openclaw/openclaw") }),
    pull_request: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    candidate_sha: sha,
    scenario: z.literal("telegram-bot-e2e-proof"),
    workflow: z.strictObject({
      path: z.literal(".github/workflows/mantis-telegram-bot-e2e-proof.yml"),
      sha,
    }),
    harness: z.strictObject({ sha }),
    run: z.strictObject({ id: messageId, attempt: z.literal(1) }),
  })
  .refine((value) => value.workflow.sha === value.harness.sha, "Workflow/harness mismatch");

const binding = z.strictObject({
  schema: z.literal("mantis.telegram-observation.v2"),
  request_id: digest,
  plan_sha256: digest,
  scenario: z.literal("telegram-bot-e2e-proof"),
  candidate_sha: sha,
  harness_sha: sha,
  run_id: messageId,
  run_attempt: z.literal(1),
  transport: z.literal("TelegramTestServer"),
  test_dc: z.literal(true),
  chat_type: z.literal("dm"),
  conversation_digest: digest,
  capture: z.literal("complete"),
});
const event = z.strictObject({
  kind: z.enum(["action", "message", "edit", "edit-meta", "delete", "typing", "reaction"]),
  elapsed_ms: z.number().nonnegative(),
  message_id: z.string().max(32).nullable(),
  actor: z.enum(["tester", "sut", "unknown"]),
  text: z.string().max(8192).optional(),
  action_type: z.string().max(32).optional(),
  status: z.string().max(32).optional(),
  reply_to: z.string().max(32).nullable().optional(),
  content_type: z.string().max(128).optional(),
  reaction_text: z.string().max(512).optional(),
  reaction_count: z.number().int().nonnegative().optional(),
  permanent: z.boolean().optional(),
  has_reply_markup: z.boolean().optional(),
  entities: z
    .array(
      z.strictObject({
        offset: z.number().int().nonnegative(),
        length: z.number().int().nonnegative(),
        type: z.string().max(128),
        url: z.string().max(2048).optional(),
        language: z.string().max(128).optional(),
      }),
    )
    .max(256)
    .optional(),
  buttons: z
    .array(z.array(z.strictObject({ text: z.string().max(128), type: z.string().max(128) })).max(8))
    .max(8)
    .optional(),
});
export const telegramSendObservationSchema = binding.extend({
  kind: z.literal("telegram-send"),
  plan: telegramProofPlanSchema,
  actions: z.array(event).max(8),
});
export const telegramProviderObservationSchema = binding.extend({
  kind: z.literal("provider-request"),
  requests: z
    .array(
      z.strictObject({
        user_text: z.string().max(16384),
        response_text: z.string().max(8192),
        streaming: z.boolean(),
      }),
    )
    .max(8),
});
export const telegramReplyObservationSchema = binding.extend({
  kind: z.literal("telegram-reply"),
  events: z.array(event).max(256),
});
function telegramProofDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function verifyTelegramProofFiles(
  identity: z.infer<typeof telegramProofIdentitySchema>,
  encoded: unknown,
) {
  const files = z
    .strictObject({
      "telegram-send.json": z.string().max(87384),
      "provider-request.json": z.string().max(87384),
      "telegram-reply.json": z.string().max(87384),
    })
    .parse(encoded);
  const schemas = {
    "telegram-send.json": telegramSendObservationSchema,
    "provider-request.json": telegramProviderObservationSchema,
    "telegram-reply.json": telegramReplyObservationSchema,
  };
  const ids = {
    "telegram-send.json": "telegram-send",
    "provider-request.json": "provider-request",
    "telegram-reply.json": "telegram-reply",
  };
  let conversation: string | undefined;
  const observations = Object.entries(files).map(([filename, encodedFile]) => {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encodedFile)) {
      throw new Error("Invalid encoded observation");
    }
    const bytes = Buffer.from(encodedFile, "base64");
    if (bytes.length > 65536) {
      throw new Error("Oversized Telegram observation");
    }
    const key = filename as keyof typeof files;
    const fact = schemas[key].parse(JSON.parse(bytes.toString("utf8")));
    if ("plan" in fact) {
      parseTelegramProofPlan(JSON.stringify(fact.plan), identity.plan_sha256);
    }
    if (
      fact.request_id !== identity.request_id ||
      fact.plan_sha256 !== identity.plan_sha256 ||
      fact.candidate_sha !== identity.candidate_sha ||
      fact.harness_sha !== identity.harness.sha ||
      fact.run_id !== identity.run.id ||
      fact.run_attempt !== identity.run.attempt ||
      (conversation !== undefined && fact.conversation_digest !== conversation)
    ) {
      throw new Error("Cross-request or stale Telegram observations");
    }
    conversation = fact.conversation_digest;
    return {
      id: ids[key],
      source_path: filename,
      expected: "Inspect the selected claim against the complete observation",
      actual: "Complete trusted observation; semantic assessment belongs to the original reviewer",
      sha256: telegramProofDigest(bytes),
      availability: "present" as const,
      authority: "trusted_observer" as const,
    };
  });
  return { assertion_outcome: "inconclusive" as const, observations };
}
