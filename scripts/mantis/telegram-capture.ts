import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  telegramProofDigest,
  telegramProofPrompt,
  telegramProofReply,
  telegramSendObservationSchema,
  telegramProviderObservationSchema,
  telegramReplyObservationSchema,
} from "./telegram-request-proof.ts";

const integer = z.number().int().safe().positive();
const summarySchema = z.object({
  recordingComplete: z.literal(true),
  chatId: z.string(),
  sentMessageId: integer,
  sentMessageIds: z.array(integer).length(1),
});
const readySchema = z.object({
  chatId: z.number().int().safe(),
  chatType: z.literal("private"),
  peerUserId: integer,
});
const rowSchema = z.object({
  kind: z.string(),
  messageId: z.number().int().safe().nullable(),
  botApiMessageId: z.number().int().safe().nullable(),
  elapsedMs: z.number().nonnegative(),
  text: z.string().max(65536).optional(),
  actionType: z.string().optional(),
  status: z.string().optional(),
  raw: z.unknown().optional(),
});
const messageSchema = z.object({
  id: integer,
  chat_id: z.number().int().safe(),
  sender_id: z.object({ "@type": z.literal("messageSenderUser"), user_id: integer }),
  content: z.object({
    "@type": z.literal("messageText"),
    text: z.object({ text: z.string().max(65536) }),
  }),
  reply_to: z.object({ message_id: integer.optional() }).optional(),
  reply_to_message_id: integer.optional(),
});
function botMessageId(value: number) {
  if (value % 1048576 !== 0 || value <= 0) {
    throw new Error("Non-final TDLib message identity");
  }
  return String(value / 1048576);
}

// Only the trusted controller calls this after the canonical recorder finishes
// and the SUT is quiescent. Private raw identities never leave this function.
export function normalizeTelegramCapture(input: {
  identity: {
    request_id: string;
    candidate_sha: string;
    harness: { sha: string };
    run: { id: string; attempt: number };
  };
  nonce: string;
  salt: Uint8Array;
  sutId: number;
  testerId: number;
  testDc: boolean;
  ready: unknown;
  summary: unknown;
  raw: string;
  provider: {
    inputNonce: string;
    responseNonce: string;
    responseSha256: string;
    count: number;
  };
  quiescent: boolean;
  leaseHealthy: boolean;
  rejectedReply?: { textSha256: string };
}) {
  if (
    !input.testDc ||
    !input.quiescent ||
    !input.leaseHealthy ||
    input.provider.count !== 1 ||
    input.raw.length > 8 * 1024 * 1024 ||
    input.salt.byteLength < 32
  ) {
    throw new Error("Incomplete Telegram capture boundary");
  }
  const ready = readySchema.parse(input.ready);
  const summary = summarySchema.parse(input.summary);
  if (
    ready.peerUserId !== input.sutId ||
    String(ready.chatId) !== summary.chatId ||
    summary.sentMessageIds[0] !== summary.sentMessageId
  ) {
    throw new Error("Telegram peer/send identity mismatch");
  }
  const lines = input.raw.trim().split("\n");
  if (lines.length > 4096) {
    throw new Error("Oversized Telegram timeline");
  }
  const rows = lines.map((line) => {
    if (line.length > 65536) {
      throw new Error("Oversized TDLib event");
    }
    return rowSchema.parse(JSON.parse(line));
  });
  const sends = rows
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) => row.kind === "action" && row.actionType === "send" && row.status === "completed",
    );
  const sent = sends[0];
  if (
    sends.length !== 1 ||
    !sent ||
    sent.row.messageId !== summary.sentMessageId ||
    sent.row.text !== telegramProofPrompt(input.nonce)
  ) {
    throw new Error("Missing canonical sent action");
  }
  const sendId = botMessageId(summary.sentMessageId);
  const replies = rows.slice(sent.index + 1).flatMap((row) => {
    if (row.kind !== "message") {
      return [];
    }
    const raw = z
      .object({ "@type": z.literal("updateNewMessage"), message: messageSchema })
      .safeParse(row.raw);
    if (!raw.success) {
      return [];
    }
    const message = raw.data.message;
    if (
      message.chat_id !== ready.chatId ||
      message.sender_id.user_id !== input.sutId ||
      message.id !== row.messageId ||
      botMessageId(message.id) !== String(row.botApiMessageId)
    ) {
      return [];
    }
    if (row.elapsedMs < sent.row.elapsedMs) {
      throw new Error("Out-of-order Telegram capture");
    }
    return [message];
  });
  // Streaming is disabled for this bounded scenario. More than one SUT message
  // is ambiguous, rather than permission to select whichever happens to pass.
  const reply = replies[0];
  if (input.rejectedReply ? replies.length !== 0 : replies.length !== 1 || !reply) {
    throw new Error("Missing or ambiguous same-SUT DM reply");
  }
  const expectedResponse = telegramProofDigest(telegramProofReply(input.provider.responseNonce));
  const rejectedReply =
    input.rejectedReply &&
    z
      .strictObject({
        textSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(input.rejectedReply);
  if (rejectedReply?.textSha256 === expectedResponse) {
    throw new Error("Blocked reply must be a trusted observed mismatch");
  }
  if (
    input.provider.inputNonce !== input.nonce ||
    input.provider.responseSha256 !== expectedResponse
  ) {
    throw new Error("Provider request correlation mismatch");
  }
  const conversation = createHmac("sha256", input.salt)
    .update(
      JSON.stringify([
        input.identity.request_id,
        input.identity.run,
        ready.chatId,
        input.sutId,
        input.testerId,
      ]),
    )
    .digest("hex");
  const common = {
    schema: "mantis.telegram-observation.v1",
    request_id: input.identity.request_id,
    scenario: "telegram-bot-e2e-proof",
    candidate_sha: input.identity.candidate_sha,
    harness_sha: input.identity.harness.sha,
    run_id: input.identity.run.id,
    run_attempt: input.identity.run.attempt,
    transport: "TelegramTestServer",
    test_dc: true,
    chat_type: "dm",
    conversation_digest: conversation,
    nonce: input.nonce,
    capture: "complete",
  };
  const quote = reply?.reply_to?.message_id ?? reply?.reply_to_message_id;
  const replyTo = quote ? botMessageId(quote) : null;
  if (replyTo !== null && replyTo !== sendId) {
    throw new Error("Wrong Telegram reply target");
  }
  return {
    "telegram-send.json": telegramSendObservationSchema.parse({
      ...common,
      kind: "telegram-send",
      message_id: sendId,
      text_sha256: telegramProofDigest(sent.row.text),
    }),
    "provider-request.json": telegramProviderObservationSchema.parse({
      ...common,
      kind: "provider-request",
      input_nonce: input.provider.inputNonce,
      response_nonce: input.provider.responseNonce,
      response_sha256: input.provider.responseSha256,
    }),
    "telegram-reply.json": telegramReplyObservationSchema.parse({
      ...common,
      kind: "telegram-reply",
      from_sut: true,
      ...(rejectedReply
        ? { delivery: "blocked_before_forward", message_id: null }
        : { message_id: botMessageId(reply!.id) }),
      in_reply_to: replyTo,
      text_sha256: rejectedReply?.textSha256 ?? telegramProofDigest(reply!.content.text.text),
    }),
  };
}
