import { createHmac } from "node:crypto";
import { z } from "zod";
import type { TelegramProofPlan } from "./telegram-proof-plan.ts";
import {
  telegramSendObservationSchema,
  telegramProviderObservationSchema,
  telegramReplyObservationSchema,
} from "./telegram-request-proof.ts";

const rowSchema = z.object({
  kind: z.enum(["action", "message", "edit", "edit-meta", "delete", "typing", "reaction"]),
  messageId: z.number().int().safe().nullable(),
  elapsedMs: z.number().nonnegative(),
  senderId: z.number().int().safe().optional(),
  isSut: z.boolean().optional(),
  isOutgoing: z.boolean().optional(),
  text: z.string().max(8192).optional(),
  actionType: z.string().max(32).optional(),
  status: z.string().max(32).optional(),
  replyToMessageId: z.number().int().safe().nullable().optional(),
  contentType: z.string().max(128).optional(),
  reactionText: z.string().max(512).optional(),
  reactionCount: z.number().int().nonnegative().optional(),
  isPermanent: z.boolean().optional(),
  hasReplyMarkup: z.boolean().optional(),
  raw: z.unknown().optional(),
});
export function normalizeTelegramCapture(input: {
  identity: {
    request_id: string;
    plan_sha256: string;
    candidate_sha: string;
    harness: { sha: string };
    run: { id: string; attempt: number };
  };
  plan: TelegramProofPlan;
  salt: Uint8Array;
  sutId: number;
  testerId: number;
  testDc: boolean;
  ready: unknown;
  summary: unknown;
  raw: string;
  provider: Array<{ user_text: string; response_text: string; streaming: boolean }>;
  quiescent: boolean;
  leaseHealthy: boolean;
  privateValues: string[];
}) {
  if (
    !input.testDc ||
    !input.quiescent ||
    !input.leaseHealthy ||
    Buffer.byteLength(input.raw) > 8 * 1024 * 1024 ||
    input.salt.byteLength < 32
  ) {
    throw new Error("Incomplete Telegram capture boundary");
  }
  const ready = z
    .object({
      chatId: z.number().int().safe(),
      chatType: z.literal("private"),
      peerUserId: z.number().int().safe().positive(),
    })
    .parse(input.ready);
  const summary = z
    .object({
      recordingComplete: z.literal(true),
      chatId: z.string(),
      sentMessageIds: z.array(z.number().int().safe()).max(8),
    })
    .parse(input.summary);
  if (ready.peerUserId !== input.sutId || String(ready.chatId) !== summary.chatId) {
    throw new Error("Recorder does not own the selected Test Server DM");
  }
  const secrets = [
    ...input.privateValues,
    String(input.sutId),
    String(input.testerId),
    String(ready.chatId),
  ]
    .filter(Boolean)
    .toSorted((a, b) => b.length - a.length);
  const redact = (text: string) =>
    secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
  const ids = new Map<number, string>();
  const messageId = (value: number | null | undefined) => {
    if (value === null || value === undefined) {
      return null;
    }
    if (!ids.has(value)) {
      ids.set(value, `message-${ids.size + 1}`);
    }
    return ids.get(value)!;
  };
  const lines = input.raw.trim().split("\n");
  if (lines.length > 256 || lines.some((line) => Buffer.byteLength(line) > 65536)) {
    throw new Error("Telegram timeline exceeds the complete observation budget");
  }
  const rows = lines.map((line) => rowSchema.parse(JSON.parse(line)));
  const actions = rows.filter((row) => row.kind === "action");
  if (
    actions.length !== input.plan.actions.length ||
    actions.some((row, index) => row.actionType !== input.plan.actions[index]!.type) ||
    actions.filter((row) => row.actionType === "send" && row.status === "completed").length !==
      summary.sentMessageIds.length
  ) {
    throw new Error("Incomplete canonical recorder actions");
  }
  let previous = -1;
  const projectEvent = (row: z.infer<typeof rowSchema>) => {
    if (row.elapsedMs < previous) {
      throw new Error("Out-of-order recorder timeline");
    }
    previous = row.elapsedMs;
    const actor =
      row.kind === "action" || row.senderId === input.testerId || row.isOutgoing === true
        ? "tester"
        : row.senderId === input.sutId || row.isSut === true
          ? "sut"
          : "unknown";
    const source = z
      .object({
        message: z
          .object({ content: z.unknown().optional(), reply_markup: z.unknown().optional() })
          .optional(),
        new_content: z.unknown().optional(),
        reply_markup: z.unknown().optional(),
      })
      .parse(row.raw ?? {});
    const content = z
      .object({
        text: z
          .object({
            entities: z
              .array(
                z.object({
                  offset: z.number().int().nonnegative(),
                  length: z.number().int().nonnegative(),
                  type: z.object({
                    "@type": z.string().max(128),
                    url: z.string().max(2048).optional(),
                    language: z.string().max(128).optional(),
                  }),
                }),
              )
              .max(256)
              .optional(),
          })
          .optional(),
      })
      .parse(source.message?.content ?? source.new_content ?? {});
    const keyboard = z
      .object({
        rows: z
          .array(
            z
              .array(
                z.object({
                  text: z.string().max(128),
                  type: z.object({ "@type": z.string().max(128) }),
                }),
              )
              .max(8),
          )
          .max(8)
          .optional(),
      })
      .parse(source.message?.reply_markup ?? source.reply_markup ?? {});
    return {
      kind: row.kind,
      elapsed_ms: row.elapsedMs,
      message_id: messageId(row.messageId),
      actor,
      ...(row.text !== undefined ? { text: redact(row.text) } : {}),
      ...(row.actionType !== undefined ? { action_type: row.actionType } : {}),
      ...(row.status !== undefined ? { status: row.status } : {}),
      ...(row.replyToMessageId !== undefined ? { reply_to: messageId(row.replyToMessageId) } : {}),
      ...(row.contentType !== undefined ? { content_type: row.contentType } : {}),
      ...(row.reactionText !== undefined ? { reaction_text: redact(row.reactionText) } : {}),
      ...(row.reactionCount !== undefined ? { reaction_count: row.reactionCount } : {}),
      ...(row.isPermanent !== undefined ? { permanent: row.isPermanent } : {}),
      ...(row.hasReplyMarkup !== undefined ? { has_reply_markup: row.hasReplyMarkup } : {}),
      ...(content.text?.entities
        ? {
            entities: content.text.entities.map(({ offset, length, type }) =>
              Object.assign(
                {
                  offset,
                  length,
                  type: type["@type"],
                },
                type.url ? { url: redact(type.url) } : {},
                type.language ? { language: redact(type.language) } : {},
              ),
            ),
          }
        : {}),
      ...(keyboard.rows
        ? {
            buttons: keyboard.rows.map((buttons) =>
              buttons.map((button) => ({ text: redact(button.text), type: button.type["@type"] })),
            ),
          }
        : {}),
    };
  };
  const events = rows.map(projectEvent);
  const conversation = createHmac("sha256", input.salt)
    .update(JSON.stringify([input.identity.request_id, input.identity.run, ready.chatId]))
    .digest("hex");
  const common = {
    schema: "mantis.telegram-observation.v2",
    request_id: input.identity.request_id,
    plan_sha256: input.identity.plan_sha256,
    scenario: "telegram-bot-e2e-proof",
    candidate_sha: input.identity.candidate_sha,
    harness_sha: input.identity.harness.sha,
    run_id: input.identity.run.id,
    run_attempt: input.identity.run.attempt,
    transport: "TelegramTestServer",
    test_dc: true,
    chat_type: "dm",
    conversation_digest: conversation,
    capture: "complete",
  };
  return {
    "telegram-send.json": telegramSendObservationSchema.parse({
      ...common,
      kind: "telegram-send",
      plan: input.plan,
      actions: events.filter((event) => event.kind === "action"),
    }),
    "provider-request.json": telegramProviderObservationSchema.parse({
      ...common,
      kind: "provider-request",
      requests: input.provider.map((request) => ({
        user_text: redact(request.user_text),
        response_text: redact(request.response_text),
        streaming: request.streaming,
      })),
    }),
    "telegram-reply.json": telegramReplyObservationSchema.parse({
      ...common,
      kind: "telegram-reply",
      events,
    }),
  };
}
