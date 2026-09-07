import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";

const eventEnvelopeSchema = z.object({ type: z.string() }).passthrough();
const sessionStartedSchema = z
  .object({
    type: z.literal("session.started"),
    session: z.object({ expires_at: z.number().optional() }).passthrough(),
  })
  .passthrough();
const transcriptAddedSchema = z
  .object({
    item: z.object({ text: z.string() }).passthrough(),
  })
  .passthrough();
const outputAudioDeltaSchema = z
  .object({
    type: z.literal("output_audio.delta"),
    audio: z.string(),
  })
  .passthrough();
const turnDoneSchema = z
  .object({
    turn: z
      .object({
        role: z.enum(["user", "assistant"]),
        transcript: z.string(),
      })
      .passthrough(),
  })
  .passthrough();
const delegationSchema = z
  .object({
    type: z.literal("delegation.created"),
    item: z
      .object({
        type: z.string(),
        target: z.string(),
        id: z.string().optional(),
        content: z
          .array(
            z
              .object({
                type: z.string(),
                text: z.string().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type OpenAIQuicksilverInboundEvent =
  | { kind: "ignored"; eventType: string }
  | { kind: "session-started"; expiresAt?: number }
  | { kind: "audio-cleared" }
  | { kind: "audio"; data: string }
  | { kind: "transcript-delta"; role: "user" | "assistant"; text: string }
  | { kind: "transcript-done"; role: "user" | "assistant"; text: string }
  | { kind: "delegation"; id: string; prompt: string }
  | { kind: "error"; message: string; fatalAuth: boolean }
  | { kind: "unknown"; eventType: string };

function readQuicksilverErrorMessage(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  const record = asOptionalObjectRecord(value);
  if (record) {
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
    const error = record.error;
    if (error && typeof error === "object") {
      const nestedMessage = asOptionalObjectRecord(error)?.message;
      if (typeof nestedMessage === "string" && nestedMessage.trim()) {
        return nestedMessage.trim();
      }
    }
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
    try {
      const serialized = JSON.stringify(error ?? value);
      if (serialized && serialized !== "{}") {
        return serialized;
      }
    } catch {
      // Fall through to the stable generic diagnostic.
    }
  }
  return "GPT-Live sideband error";
}

function isFatalQuicksilverAuthError(value: unknown): boolean {
  const record = asOptionalObjectRecord(value);
  if (!record) {
    return false;
  }
  const error = asOptionalObjectRecord(record.error);
  const status = record.status ?? error?.status;
  if (status === 401 || status === "401") {
    return true;
  }
  const code =
    typeof (record.code ?? error?.code) === "string"
      ? String(record.code ?? error?.code).toLowerCase()
      : "";
  return ["authentication_error", "invalid_api_key", "invalid_token", "token_expired"].includes(
    code,
  );
}

export function parseOpenAIQuicksilverEvent(payload: string): OpenAIQuicksilverInboundEvent | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return null;
  }
  const envelope = eventEnvelopeSchema.safeParse(decoded);
  if (!envelope.success) {
    return null;
  }
  const eventType = envelope.data.type;
  if (eventType === "session.started") {
    const started = sessionStartedSchema.safeParse(decoded);
    if (!started.success) {
      return { kind: "ignored", eventType };
    }
    const expiresAt = started.data.session.expires_at;
    return {
      kind: "session-started",
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }
  if (eventType === "input_transcript.added" || eventType === "output_transcript.added") {
    const transcript = transcriptAddedSchema.safeParse(decoded);
    return transcript.success
      ? {
          kind: "transcript-delta",
          role: eventType === "input_transcript.added" ? "user" : "assistant",
          text: transcript.data.item.text,
        }
      : { kind: "ignored", eventType };
  }
  if (eventType === "turn.done") {
    const turn = turnDoneSchema.safeParse(decoded);
    return turn.success
      ? { kind: "transcript-done", role: turn.data.turn.role, text: turn.data.turn.transcript }
      : { kind: "ignored", eventType };
  }
  if (eventType === "output_audio.delta") {
    const audio = outputAudioDeltaSchema.safeParse(decoded);
    return audio.success
      ? { kind: "audio", data: audio.data.audio }
      : { kind: "ignored", eventType };
  }
  if (eventType === "output_audio_buffer.cleared") {
    return { kind: "audio-cleared" };
  }
  if (eventType === "session.updated") {
    return { kind: "ignored", eventType };
  }
  if (eventType === "delegation.created") {
    const delegation = delegationSchema.safeParse(decoded);
    if (!delegation.success) {
      return { kind: "ignored", eventType };
    }
    const { item } = delegation.data;
    if (item.type !== "delegation" || item.target !== "client" || !item.id) {
      return { kind: "ignored", eventType };
    }
    return {
      kind: "delegation",
      id: item.id,
      prompt: (item.content ?? [])
        .filter((part) => part.type === "input_text")
        .map((part) => part.text ?? "")
        .join(""),
    };
  }
  if (eventType === "error") {
    return {
      kind: "error",
      message: readQuicksilverErrorMessage(decoded),
      fatalAuth: isFatalQuicksilverAuthError(decoded),
    };
  }
  return { kind: "unknown", eventType };
}
