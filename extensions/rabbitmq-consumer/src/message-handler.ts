import { z } from "zod";
import type { AttachmentRef, ChatCancelMessage, ChatMessage } from "./types.js";

/**
 * Zod schema for validating incoming RabbitMQ messages.
 * Supports both old format (with `body` field) and new flat format.
 */
// template_id may arrive as a number or a numeric string (PHP/JSON producers
// vary); coerce to a positive int and drop anything else (0/"" => undefined).
const templateIdSchema = z
  .union([z.number(), z.string()])
  .optional()
  .transform((value) => {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    const n = typeof value === "number" ? value : parseInt(value, 10);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  });

// Active custom skill ids. Additive/optional: ordinary chat and old producers
// omit it. Each element may arrive as a number or numeric string (producers
// vary); coerce to positive ints, drop the rest, de-dupe, and cap. A malformed
// or missing value degrades to undefined (no skills) rather than failing the
// whole message parse — never silently drop the user's turn over a bad id.
const SKILL_IDS_MAX = 20;
const skillIdsSchema = z
  .array(z.union([z.number(), z.string()]))
  .optional()
  .transform((value) => {
    if (!value || value.length === 0) {
      return undefined;
    }
    const ids: number[] = [];
    const seen = new Set<number>();
    for (const v of value) {
      const n = typeof v === "number" ? v : parseInt(v, 10);
      if (Number.isInteger(n) && n > 0 && !seen.has(n)) {
        seen.add(n);
        ids.push(n);
      }
    }
    return ids.length ? ids.slice(0, SKILL_IDS_MAX) : undefined;
  });

// Both the web producer and chat pipeline validate public catalog membership.
// Keep transport validation extensible for administrator-created skills.
const builtinSkillNameSchema = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  .optional()
  .catch(undefined);

// Attachment reference (see types.AttachmentRef). Additive and optional:
// ordinary chat and old producers omit it. Validated per-element by
// parseAttachments (NOT inline in the message schema) so a malformed/old-format
// attachment is dropped — degrading to overview+sample — and never fails the
// whole message parse (which would silently drop the user's turn).
// `spreadsheet` carries totalDataRows. Any attachment may carry the original
// OSS object key: document keys feed stampedComplaint directly, while image
// keys feed infringe_profile_save. An image without an ossKey is unusable for
// profile persistence, so it is refined out; documents retain their public ref
// as a backward-compatible stampedComplaint fallback.
const attachmentRefSchema = z
  .object({
    fileId: z.string().min(1),
    filename: z.string().min(1),
    ext: z.string().min(1),
    kind: z.enum(["spreadsheet", "document", "image"]),
    storage: z.literal("oss"),
    ref: z.string().url(),
    totalDataRows: z.number().int().nonnegative().optional(),
    ossKey: z.string().min(1).optional(),
  })
  .refine((a) => a.kind !== "image" || !!a.ossKey, {
    message: "image attachment requires ossKey",
  });

/**
 * Coerce a raw `attachments` value into valid AttachmentRefs, dropping anything
 * that fails validation. Returns undefined when there are none — so a bad or
 * stale-format attachment can never block the message itself.
 */
function parseAttachments(raw: unknown): AttachmentRef[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const valid: AttachmentRef[] = [];
  for (const el of raw) {
    const result = attachmentRefSchema.safeParse(el);
    if (result.success) {
      valid.push(result.data);
    }
  }
  return valid.length ? valid : undefined;
}

const rabbitMqMessageSchema = z.object({
  // Control envelopes are parsed before chat messages and must never degrade
  // into an empty chat turn merely because they also carry an `id`.
  type: z.never().optional(),
  id: z.number().int().positive(),
  body: z
    .object({
      message: z.string().min(1),
      session_id: z.string().optional(),
      user_id: z.union([z.string(), z.number()]).optional(),
      use_memory: z.boolean().optional().default(true),
      use_websearch: z.boolean().optional().default(false),
      topic: z.string().optional(),
      template_id: templateIdSchema,
      skill_ids: skillIdsSchema,
      builtin_skill_name: builtinSkillNameSchema,
      has_attachment: z.boolean().optional(),
      // Lenient on purpose: validated/filtered by parseAttachments so a bad
      // entry never fails the whole message. See attachmentRefSchema note.
      attachments: z.unknown().optional(),
    })
    .optional(),
  message: z.string().optional(),
  session_id: z.string().optional(),
  user_id: z.union([z.string(), z.number()]).optional(),
  model_key: z.string().optional(),
  use_memory: z.boolean().optional().default(true),
  use_websearch: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  topic: z.string().optional(),
  template_id: templateIdSchema,
  skill_ids: skillIdsSchema,
  builtin_skill_name: builtinSkillNameSchema,
  has_attachment: z.boolean().optional(),
  // Lenient on purpose (validated by parseAttachments, see above).
  attachments: z.unknown().optional(),
});

/**
 * Warmup message: a best-effort, history-less request sent when the user opens
 * the chat, so the per-user agent (session, prompts, model connection, provider
 * context cache) is spun up before the first real message. Carries no `id`.
 */
const warmupMessageSchema = z.object({
  type: z.literal("warmup"),
  user_id: z.union([z.string(), z.number()]).optional(),
  session_id: z.string().optional(),
});

const cancelMessageSchema = z.object({
  type: z.literal("cancel"),
  id: z.number().int().positive(),
  user_id: z.union([z.string().min(1), z.number()]),
  session_id: z.string().min(1),
});

export type WarmupMessage = { userId: string; sessionId: string };

/**
 * Detect and parse a warmup message. Returns null for anything that isn't a
 * `{ type: "warmup" }` envelope, so ordinary chat messages fall through to
 * parseMessage. Must be checked BEFORE parseMessage (warmup has no `id`).
 */
export function parseWarmup(rawBody: Buffer): WarmupMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf-8"));
  } catch {
    return null;
  }
  const result = warmupMessageSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  return {
    userId: result.data.user_id != null ? String(result.data.user_id) : "",
    sessionId: result.data.session_id ?? "",
  };
}

/** Parse a chat cancellation control envelope without accepting chat payloads. */
export function parseCancel(rawBody: Buffer): ChatCancelMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf-8"));
  } catch {
    return null;
  }
  const result = cancelMessageSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  return {
    historyId: result.data.id,
    userId: String(result.data.user_id),
    sessionId: result.data.session_id,
  };
}

/**
 * Parse and validate a raw RabbitMQ message buffer into a ChatMessage.
 * Supports both old (nested `body`) and new (flat) message formats.
 */
export function parseMessage(
  rawBody: Buffer,
  logger?: { error: (msg: string) => void },
): ChatMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf-8"));
  } catch (error) {
    logger?.error(`[RABBITMQ_CONSUMER] JSON parse failed: ${String(error)}`);
    return null;
  }

  const result = rabbitMqMessageSchema.safeParse(parsed);
  if (!result.success) {
    // Surface the validation reason; a silent null made attachment/format
    // regressions impossible to diagnose from logs.
    logger?.error(
      `[RABBITMQ_CONSUMER] Schema validation failed: ${JSON.stringify(result.error.issues)}`,
    );
    return null;
  }

  const msg = result.data;

  // Old format: data inside `body` field
  if (msg.body) {
    return {
      historyId: msg.id,
      message: msg.body.message,
      sessionId: msg.body.session_id ?? "",
      userId: msg.body.user_id != null ? String(msg.body.user_id) : "",
      useMemory: msg.body.use_memory,
      useWebsearch: msg.body.use_websearch,
      topic: msg.body.topic,
      // Accept template_id from either the nested body or the top level so the
      // producer can put it wherever the rest of its fields live.
      templateId: msg.body.template_id ?? msg.template_id,
      skillIds: msg.body.skill_ids ?? msg.skill_ids,
      builtinSkillName: msg.body.builtin_skill_name ?? msg.builtin_skill_name,
      hasAttachment: msg.body.has_attachment ?? msg.has_attachment ?? false,
      attachments: parseAttachments(msg.body.attachments ?? msg.attachments),
    };
  }

  // New format: flat fields
  return {
    historyId: msg.id,
    message: msg.message ?? "",
    sessionId: msg.session_id ?? "",
    userId: msg.user_id != null ? String(msg.user_id) : "",
    modelKey: msg.model_key,
    useMemory: msg.use_memory,
    useWebsearch: msg.use_websearch,
    temperature: msg.temperature,
    maxTokens: msg.max_tokens,
    topic: msg.topic,
    templateId: msg.template_id,
    skillIds: msg.skill_ids,
    builtinSkillName: msg.builtin_skill_name,
    hasAttachment: msg.has_attachment ?? false,
    attachments: parseAttachments(msg.attachments),
  };
}
