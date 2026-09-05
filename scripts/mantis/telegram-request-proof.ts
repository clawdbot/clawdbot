import { createHash } from "node:crypto";
import { z } from "zod";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const messageId = z.string().regex(/^[1-9][0-9]{0,19}$/);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
export const telegramProofIdentitySchema = z
  .strictObject({
    request_id: digest,
    repository: z.strictObject({
      id: messageId,
      full_name: z.literal("openclaw/openclaw"),
    }),
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
  schema: z.literal("mantis.telegram-observation.v1"),
  request_id: digest,
  scenario: z.literal("telegram-bot-e2e-proof"),
  candidate_sha: z.string().regex(/^[0-9a-f]{40}$/),
  harness_sha: z.string().regex(/^[0-9a-f]{40}$/),
  run_id: messageId,
  run_attempt: z.literal(1),
  transport: z.literal("TelegramTestServer"),
  test_dc: z.literal(true),
  chat_type: z.literal("dm"),
  conversation_digest: digest,
  nonce: digest,
  capture: z.literal("complete"),
});
export const telegramSendObservationSchema = binding.extend({
  kind: z.literal("telegram-send"),
  message_id: messageId,
  text_sha256: digest,
});
export const telegramProviderObservationSchema = binding.extend({
  kind: z.literal("provider-request"),
  input_nonce: digest,
  response_nonce: digest,
  response_sha256: digest,
});
const deliveredReply = binding.extend({
  kind: z.literal("telegram-reply"),
  from_sut: z.literal(true),
  message_id: messageId,
  in_reply_to: messageId.nullable(),
  text_sha256: digest,
});
export const telegramReplyObservationSchema = z.union([
  deliveredReply,
  deliveredReply.extend({
    delivery: z.literal("blocked_before_forward"),
    message_id: z.null(),
    in_reply_to: z.null(),
  }),
]);
export const telegramObservationFiles = [
  "telegram-send.json",
  "provider-request.json",
  "telegram-reply.json",
] as const;
export function telegramProofDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function telegramProofPrompt(nonce: string): string {
  return `Mantis Telegram request ${digest.parse(nonce)}`;
}
export function telegramProofReply(nonce: string): string {
  return `MANTIS_TELEGRAM_REPLY_${digest.parse(nonce)}`;
}

// Decode only public, normalized facts. Real bot/chat/user identities and raw
// TDLib/provider records belong to the protected controller capture, never here.
export function verifyTelegramProofFiles(
  identity: z.infer<typeof telegramProofIdentitySchema>,
  encoded: unknown,
) {
  const files = z
    .strictObject({
      "telegram-send.json": z.string().max(10924),
      "provider-request.json": z.string().max(10924),
      "telegram-reply.json": z.string().max(10924),
    })
    .parse(encoded);
  function decode(value: string) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      throw new Error("Invalid encoded Telegram observation");
    }
    const bytes = Buffer.from(value, "base64");
    if (bytes.length > 8192) {
      throw new Error("Oversized Telegram observation");
    }
    return { bytes, value: JSON.parse(bytes.toString("utf8")) as unknown };
  }
  const sentFile = decode(files["telegram-send.json"]);
  const providerFile = decode(files["provider-request.json"]);
  const replyFile = decode(files["telegram-reply.json"]);
  const sent = telegramSendObservationSchema.parse(sentFile.value);
  const provider = telegramProviderObservationSchema.parse(providerFile.value);
  const reply = telegramReplyObservationSchema.parse(replyFile.value);
  for (const fact of [sent, provider, reply]) {
    if (
      fact.request_id !== identity.request_id ||
      fact.candidate_sha !== identity.candidate_sha ||
      fact.scenario !== identity.scenario ||
      fact.harness_sha !== identity.harness.sha ||
      fact.run_id !== identity.run.id ||
      fact.run_attempt !== identity.run.attempt ||
      fact.nonce !== sent.nonce ||
      fact.conversation_digest !== sent.conversation_digest
    ) {
      throw new Error("Cross-request, cross-transport or stale Telegram observations");
    }
  }
  const expectedSend = telegramProofDigest(telegramProofPrompt(sent.nonce));
  const expectedReply = telegramProofDigest(telegramProofReply(provider.response_nonce));
  if (
    sent.text_sha256 !== expectedSend ||
    provider.input_nonce !== sent.nonce ||
    provider.response_sha256 !== expectedReply ||
    reply.message_id === sent.message_id ||
    (reply.in_reply_to !== null && reply.in_reply_to !== sent.message_id)
  ) {
    throw new Error("Invalid Telegram send/provider/reply correlation");
  }
  const matched = reply.text_sha256 === expectedReply;
  const blocked = "delivery" in reply;
  if (blocked && matched) {
    throw new Error("Blocked Telegram reply is not a mismatch");
  }
  const observations = [
    {
      id: "telegram-send",
      source_path: "telegram-send.json",
      expected: expectedSend,
      actual: sent.text_sha256,
      sha256: telegramProofDigest(sentFile.bytes),
    },
    {
      id: "provider-request",
      source_path: "provider-request.json",
      expected: `${sent.nonce}:${expectedReply}`,
      actual: `${provider.input_nonce}:${provider.response_sha256}`,
      sha256: telegramProofDigest(providerFile.bytes),
    },
    {
      id: "telegram-reply",
      source_path: "telegram-reply.json",
      expected: expectedReply,
      actual: blocked
        ? `Blocked before Telegram forwarding; SHA256 ${reply.text_sha256}`
        : reply.text_sha256,
      sha256: telegramProofDigest(replyFile.bytes),
    },
  ].map((fact) => ({
    id: fact.id,
    source_path: fact.source_path,
    expected: fact.expected,
    actual: fact.actual,
    sha256: fact.sha256,
    availability: "present" as const,
    authority: "trusted_observer" as const,
  }));
  return { assertion_outcome: matched ? ("pass" as const) : ("fail" as const), observations };
}
