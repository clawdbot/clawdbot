import { z } from "openclaw/plugin-sdk/zod";
import type { CallMode } from "./config.js";

// -----------------------------------------------------------------------------
// Provider Identifiers
// -----------------------------------------------------------------------------

const ProviderNameSchema = z.enum(["telnyx", "twilio", "plivo", "mock"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

// -----------------------------------------------------------------------------
// Core Call Identifiers
// -----------------------------------------------------------------------------

/** Internal call identifier (UUID) */
export type CallId = string;

/** Provider-specific call identifier */
type ProviderCallId = string;

// -----------------------------------------------------------------------------
// Call Lifecycle States
// -----------------------------------------------------------------------------

const CallStateSchema = z.enum([
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

const EndReasonSchema = z.enum([
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
  // Stable provider-derived key for idempotency/replay dedupe.
  dedupeKey: z.string().optional(),
  callId: z.string(),
  providerCallId: z.string().optional(),
  timestamp: z.number(),
  // Optional per-turn nonce for speech events (Twilio <Gather> replay hardening).
  turnToken: z.string().optional(),
  // Optional fields for inbound call detection
  direction: z.enum(["inbound", "outbound"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const NormalizedEventSchema = z.discriminatedUnion("type", [
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

const CallDirectionSchema = z.enum(["outbound", "inbound"]);

// -----------------------------------------------------------------------------
// Call Record
// -----------------------------------------------------------------------------

const TranscriptEntrySchema = z.object({
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
  /** Signature is valid, but request was seen before within replay window. */
  isReplay?: boolean;
  /** Stable key derived from authenticated request material. */
  verifiedRequestKey?: string;
};

export type WebhookParseOptions = {
  /** Stable request key from verifyWebhook. */
  verifiedRequestKey?: string;
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
  /** Inline TwiML to execute without fetching webhook TwiML. */
  inlineTwiml?: string;
  /** TwiML to serve once before normal webhook-driven call handling resumes. */
  preConnectTwiml?: string;
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

export type AnswerCallInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
};

export type PlayTtsInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
  text: string;
  voice?: string;
  locale?: string;
};

export type SendDtmfInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
  digits: string;
};

export type StartListeningInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
  language?: string;
  /** Optional per-turn nonce for provider callbacks (replay hardening). */
  turnToken?: string;
};

export type StopListeningInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
};

// -----------------------------------------------------------------------------
// Call Status Verification (used on restart to verify persisted calls)
// -----------------------------------------------------------------------------

export type GetCallStatusInput = {
  providerCallId: ProviderCallId;
};

export type GetCallStatusResult = {
  /** Provider-specific status string (e.g. "completed", "in-progress") */
  status: string;
  /** True when the provider confirms the call has ended */
  isTerminal: boolean;
  /** True when the status could not be determined (transient error) */
  isUnknown?: boolean;
};

// -----------------------------------------------------------------------------
// Outbound Call Options
// -----------------------------------------------------------------------------

export type OutboundCallOptions = {
  /** Message to speak when call connects */
  message?: string;
  /** Call mode (overrides config default) */
  mode?: CallMode;
  /** DTMF digits to send after the call is connected */
  dtmfSequence?: string;
};
