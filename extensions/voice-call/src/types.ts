// Voice Call type declarations define plugin contracts.
import { z } from "zod";
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

// -----------------------------------------------------------------------------
// Call Lifecycle States
// -----------------------------------------------------------------------------

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

const CallStateSchema = z.enum([
  "initiated",
  "ringing",
  "answered",
  "active",
  "speaking",
  "listening",
  ...EndReasonSchema.options,
]);
export type CallState = z.infer<typeof CallStateSchema>;

export const TerminalStates = new Set<CallState>(EndReasonSchema.options);

// -----------------------------------------------------------------------------
// Normalized Call Events
// -----------------------------------------------------------------------------

export type NormalizedEvent = {
  id: string;
  // Stable provider-derived key for idempotency/replay dedupe.
  dedupeKey?: string | undefined;
  callId: string;
  providerCallId?: string | undefined;
  timestamp: number;
  // Optional per-turn nonce for speech events (Twilio <Gather> replay hardening).
  turnToken?: string | undefined;
  // Optional fields for inbound call detection
  direction?: "inbound" | "outbound" | undefined;
  from?: string | undefined;
  to?: string | undefined;
} & (
  | { type: "call.initiated" }
  | { type: "call.ringing" }
  | { type: "call.answered" }
  | { type: "call.active" }
  | { type: "call.speaking"; text: string }
  | { type: "call.assistant-speech"; transcript: string }
  | {
      type: "call.speech";
      transcript: string;
      isFinal: boolean;
      confidence?: number | undefined;
    }
  | { type: "call.silence"; durationMs: number }
  | { type: "call.dtmf"; digits: string }
  | { type: "call.ended"; reason: EndReason }
  | { type: "call.error"; error: string; retryable?: boolean | undefined }
);

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
  /** Agent selected when the call was created. Optional for legacy records. */
  agentId: z.string().optional(),
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
  /** Release only this delivery's replay reservation when processing fails. */
  releaseReplay?: () => void;
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
  /**
   * Optional `wss://` URL the carrier should open for bidirectional Media
   * Streaming on call connect. Used by carriers (e.g. Telnyx) that attach
   * streaming at dial time. Twilio learns the URL from TwiML so it ignores
   * this field.
   */
  streamUrl?: string;
  /** Per-call auth token the carrier echoes back on the WS upgrade. */
  streamAuthToken?: string;
};

export type InitiateCallResult = {
  providerCallId: string;
  status: "initiated" | "queued";
};

type CallControlInput = {
  callId: CallId;
  providerCallId: string;
};

export type HangupCallInput = CallControlInput & {
  reason: EndReason;
};

export type AnswerCallInput = CallControlInput & {
  /**
   * Optional `wss://` URL the carrier should open for bidirectional Media
   * Streaming on answer. Used by carriers (e.g. Telnyx) that attach
   * streaming at answer time. Twilio learns the URL from TwiML so it ignores
   * this field.
   */
  streamUrl?: string;
  /** Per-call auth token the carrier echoes back on the WS upgrade. */
  streamAuthToken?: string;
};

export type PlayTtsInput = CallControlInput & {
  text: string;
  voice?: string;
  locale?: string;
  /** Keep collecting speech after playback when the provider owns the listening XML. */
  listenAfterPlayback?: boolean;
};

export type SendDtmfInput = CallControlInput & {
  digits: string;
};

export type StartListeningInput = CallControlInput & {
  language?: string;
  /** Optional per-turn nonce for provider callbacks (replay hardening). */
  turnToken?: string;
};

export type StopListeningInput = CallControlInput;

// -----------------------------------------------------------------------------
// Call Status Verification (used on restart to verify persisted calls)
// -----------------------------------------------------------------------------

export type GetCallStatusInput = Pick<CallControlInput, "providerCallId">;

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
  /** Session that initiated the call, used for agent context/delegated message routing */
  requesterSessionKey?: string;
  /** Agent selected for this call instead of the plugin default. */
  agentId?: string;
};
