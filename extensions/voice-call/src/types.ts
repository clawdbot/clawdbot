import { z } from "zod";

import type { CallMode } from "./config.js";

// -----------------------------------------------------------------------------
// Provider Identifiers
// -----------------------------------------------------------------------------

export const ProviderNameSchema = z.enum(["telnyx", "twilio", "plivo", "mock"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

// -----------------------------------------------------------------------------
// Core Call Identifiers
// -----------------------------------------------------------------------------

/** Internal call identifier (UUID) */
export type CallId = string;

/** Provider-specific call identifier */
export type ProviderCallId = string;

// -----------------------------------------------------------------------------
// Call Lifecycle States
// -----------------------------------------------------------------------------

export const CallStateSchema = z.enum([
  // Non-terminal states
  "initiated",
  "ringing",
  "answered",
  "active",
  "speaking",
  "listening",
  // Terminal states
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
]);
export type CallState = z.infer<typeof CallStateSchema>;

export const TerminalStates = new Set<CallState>([
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
]);

export const EndReasonSchema = z.enum([
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
]);
export type EndReason = z.infer<typeof EndReasonSchema>;

// -----------------------------------------------------------------------------
// Normalized Call Events
// -----------------------------------------------------------------------------

const BaseEventSchema = z.object({
  id: z.string(),
  callId: z.string(),
  providerCallId: z.string().optional(),
  timestamp: z.number(),
  // Optional fields for inbound call detection
  direction: z.enum(["inbound", "outbound"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const NormalizedEventSchema = z.discriminatedUnion("type", [
  BaseEventSchema.extend({
    type: z.literal("call.initiated"),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.ringing"),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.answered"),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.active"),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.speaking"),
    text: z.string(),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.speech"),
    transcript: z.string(),
    isFinal: z.boolean(),
    confidence: z.number().min(0).max(1).optional(),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.silence"),
    durationMs: z.number(),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.dtmf"),
    digits: z.string(),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.ended"),
    reason: EndReasonSchema,
  }),
  BaseEventSchema.extend({
    type: z.literal("call.error"),
    error: z.string(),
    retryable: z.boolean().optional(),
  }),
]);
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

// -----------------------------------------------------------------------------
// Call Direction
// -----------------------------------------------------------------------------

export const CallDirectionSchema = z.enum(["outbound", "inbound"]);
export type CallDirection = z.infer<typeof CallDirectionSchema>;

// -----------------------------------------------------------------------------
// Call Record
// -----------------------------------------------------------------------------

export const TranscriptEntrySchema = z.object({
  timestamp: z.number(),
  speaker: z.enum(["bot", "user"]),
  text: z.string(),
  isFinal: z.boolean().default(true),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export const CallRecordSchema = z.object({
  callId: z.string(),
  providerCallId: z.string().optional(),
  provider: ProviderNameSchema,
  direction: CallDirectionSchema,
  state: CallStateSchema,
  from: z.string(),
  to: z.string(),
  sessionKey: z.string().optional(),
  startedAt: z.number(),
  answeredAt: z.number().optional(),
  endedAt: z.number().optional(),
  endReason: EndReasonSchema.optional(),
  transcript: z.array(TranscriptEntrySchema).default([]),
  processedEventIds: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CallRecord = z.infer<typeof CallRecordSchema>;

// -----------------------------------------------------------------------------
// Webhook Types
// -----------------------------------------------------------------------------

export type WebhookVerificationResult = {
  ok: boolean;
  reason?: string;
};

export type WebhookContext = {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  query?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
};

export type ProviderWebhookParseResult = {
  events: NormalizedEvent[];
  providerResponseBody?: string;
  providerResponseHeaders?: Record<string, string>;
  statusCode?: number;
};

// -----------------------------------------------------------------------------
// Provider Method Types
// -----------------------------------------------------------------------------

export type InitiateCallInput = {
  callId: CallId;
  from: string;
  to: string;
  webhookUrl: string;
  clientState?: Record<string, string>;
  /** Inline TwiML to execute (skips webhook, used for notify mode) */
  inlineTwiml?: string;
};

export type InitiateCallResult = {
  providerCallId: ProviderCallId;
  status: "initiated" | "queued";
};

export type HangupCallInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
  reason: EndReason;
};

export type PlayTtsInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
  text: string;
  voice?: string;
  locale?: string;
};

export type StartListeningInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
  language?: string;
};

export type StopListeningInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
};

// -----------------------------------------------------------------------------
// Outbound Call Options
// -----------------------------------------------------------------------------

export type OutboundCallOptions = {
  /** Message to speak when call connects */
  message?: string;
  /** Call mode (overrides config default) */
  mode?: CallMode;
};

// -----------------------------------------------------------------------------
// Tool Result Types
// -----------------------------------------------------------------------------

export type InitiateCallToolResult = {
  success: boolean;
  callId?: string;
  status?: "initiated" | "queued" | "no-answer" | "busy" | "failed";
  error?: string;
};

export type ContinueCallToolResult = {
  success: boolean;
  transcript?: string;
  error?: string;
};

export type SpeakToUserToolResult = {
  success: boolean;
  error?: string;
};

export type EndCallToolResult = {
  success: boolean;
  error?: string;
};
