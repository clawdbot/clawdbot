import { z } from "zod";

// -----------------------------------------------------------------------------
// Phone Number Validation
// -----------------------------------------------------------------------------

/**
 * E.164 phone number format: +[country code][number]
 * Examples use 555 prefix (reserved for fictional numbers)
 */
export const E164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 format, e.g. +15550001234");

// -----------------------------------------------------------------------------
// Inbound Policy
// -----------------------------------------------------------------------------

/**
 * Controls how inbound calls are handled:
 * - "disabled": Block all inbound calls (outbound only)
 * - "allowlist": Only accept calls from numbers in allowFrom
 * - "pairing": Unknown callers can request pairing (future)
 * - "open": Accept all inbound calls (dangerous!)
 */
export const InboundPolicySchema = z.enum([
  "disabled",
  "allowlist",
  "pairing",
  "open",
]);
export type InboundPolicy = z.infer<typeof InboundPolicySchema>;

// -----------------------------------------------------------------------------
// Provider-Specific Configuration
// -----------------------------------------------------------------------------

export const TelnyxConfigSchema = z
  .object({
  /** Telnyx API v2 key */
  apiKey: z.string().min(1).optional(),
  /** Telnyx connection ID (from Call Control app) */
  connectionId: z.string().min(1).optional(),
  /** Public key for webhook signature verification */
  publicKey: z.string().min(1).optional(),
})
  .strict();
export type TelnyxConfig = z.infer<typeof TelnyxConfigSchema>;

export const TwilioConfigSchema = z
  .object({
  /** Twilio Account SID */
  accountSid: z.string().min(1).optional(),
  /** Twilio Auth Token */
  authToken: z.string().min(1).optional(),
})
  .strict();
export type TwilioConfig = z.infer<typeof TwilioConfigSchema>;

export const PlivoConfigSchema = z
  .object({
  /** Plivo Auth ID (starts with MA/SA) */
  authId: z.string().min(1).optional(),
  /** Plivo Auth Token */
  authToken: z.string().min(1).optional(),
})
  .strict();
export type PlivoConfig = z.infer<typeof PlivoConfigSchema>;

// -----------------------------------------------------------------------------
// STT/TTS Configuration
// -----------------------------------------------------------------------------

export const SttConfigSchema = z
  .object({
    /** STT provider (currently only OpenAI supported) */
    provider: z.literal("openai").default("openai"),
    /** Whisper model to use */
    model: z.string().min(1).default("whisper-1"),
  })
  .strict()
  .default({ provider: "openai", model: "whisper-1" });
export type SttConfig = z.infer<typeof SttConfigSchema>;

export const TtsProviderSchema = z.enum(["openai", "elevenlabs", "edge"]);
export const TtsModeSchema = z.enum(["final", "all"]);
export const TtsAutoSchema = z.enum(["off", "always", "inbound", "tagged"]);

export const TtsConfigSchema = z
  .object({
    auto: TtsAutoSchema.optional(),
    enabled: z.boolean().optional(),
    mode: TtsModeSchema.optional(),
    provider: TtsProviderSchema.optional(),
    summaryModel: z.string().optional(),
    modelOverrides: z
      .object({
        enabled: z.boolean().optional(),
        allowText: z.boolean().optional(),
        allowProvider: z.boolean().optional(),
        allowVoice: z.boolean().optional(),
        allowModelId: z.boolean().optional(),
        allowVoiceSettings: z.boolean().optional(),
        allowNormalization: z.boolean().optional(),
        allowSeed: z.boolean().optional(),
      })
      .strict()
      .optional(),
    elevenlabs: z
      .object({
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        voiceId: z.string().optional(),
        modelId: z.string().optional(),
        seed: z.number().int().min(0).max(4294967295).optional(),
        applyTextNormalization: z.enum(["auto", "on", "off"]).optional(),
        languageCode: z.string().optional(),
        voiceSettings: z
          .object({
            stability: z.number().min(0).max(1).optional(),
            similarityBoost: z.number().min(0).max(1).optional(),
            style: z.number().min(0).max(1).optional(),
            useSpeakerBoost: z.boolean().optional(),
            speed: z.number().min(0.5).max(2).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    openai: z
      .object({
        apiKey: z.string().optional(),
        model: z.string().optional(),
        voice: z.string().optional(),
      })
      .strict()
      .optional(),
    edge: z
      .object({
        enabled: z.boolean().optional(),
        voice: z.string().optional(),
        lang: z.string().optional(),
        outputFormat: z.string().optional(),
        pitch: z.string().optional(),
        rate: z.string().optional(),
        volume: z.string().optional(),
        saveSubtitles: z.boolean().optional(),
        proxy: z.string().optional(),
        timeoutMs: z.number().int().min(1000).max(120000).optional(),
      })
      .strict()
      .optional(),
    prefsPath: z.string().optional(),
    maxTextLength: z.number().int().min(1).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  })
  .strict()
  .optional();
export type VoiceCallTtsConfig = z.infer<typeof TtsConfigSchema>;

// -----------------------------------------------------------------------------
// Webhook Server Configuration
// -----------------------------------------------------------------------------

export const VoiceCallServeConfigSchema = z
  .object({
    /** Port to listen on */
    port: z.number().int().positive().default(3334),
    /** Bind address */
    bind: z.string().default("127.0.0.1"),
    /** Webhook path */
    path: z.string().min(1).default("/voice/webhook"),
  })
  .strict()
  .default({ port: 3334, bind: "127.0.0.1", path: "/voice/webhook" });
export type VoiceCallServeConfig = z.infer<typeof VoiceCallServeConfigSchema>;

export const VoiceCallTailscaleConfigSchema = z
  .object({
    /**
     * Tailscale exposure mode:
     * - "off": No Tailscale exposure
     * - "serve": Tailscale serve (private to tailnet)
     * - "funnel": Tailscale funnel (public HTTPS)
     */
    mode: z.enum(["off", "serve", "funnel"]).default("off"),
    /** Path for Tailscale serve/funnel (should usually match serve.path) */
    path: z.string().min(1).default("/voice/webhook"),
  })
  .strict()
  .default({ mode: "off", path: "/voice/webhook" });
export type VoiceCallTailscaleConfig = z.infer<
  typeof VoiceCallTailscaleConfigSchema
>;

// -----------------------------------------------------------------------------
// Tunnel Configuration (unified ngrok/tailscale)
// -----------------------------------------------------------------------------

export const VoiceCallTunnelConfigSchema = z
  .object({
    /**
     * Tunnel provider:
     * - "none": No tunnel (use publicUrl if set, or manual setup)
     * - "ngrok": Use ngrok for public HTTPS tunnel
     * - "tailscale-serve": Tailscale serve (private to tailnet)
     * - "tailscale-funnel": Tailscale funnel (public HTTPS)
     */
    provider: z
      .enum(["none", "ngrok", "tailscale-serve", "tailscale-funnel"])
      .default("none"),
    /** ngrok auth token (optional, enables longer sessions and more features) */
    ngrokAuthToken: z.string().min(1).optional(),
    /** ngrok custom domain (paid feature, e.g., "myapp.ngrok.io") */
    ngrokDomain: z.string().min(1).optional(),
    /**
     * Allow ngrok free tier compatibility mode.
     * When true, signature verification failures on ngrok-free.app URLs
     * will be logged but allowed through. Less secure, but necessary
     * for ngrok free tier which may modify URLs.
     */
    allowNgrokFreeTier: z.boolean().default(true),
  })
  .strict()
  .default({ provider: "none", allowNgrokFreeTier: true });
export type VoiceCallTunnelConfig = z.infer<typeof VoiceCallTunnelConfigSchema>;

// -----------------------------------------------------------------------------
// Outbound Call Configuration
// -----------------------------------------------------------------------------

/**
 * Call mode determines how outbound calls behave:
 * - "notify": Deliver message and auto-hangup after delay (one-way notification)
 * - "conversation": Stay open for back-and-forth until explicit end or timeout
 */
export const CallModeSchema = z.enum(["notify", "conversation"]);
export type CallMode = z.infer<typeof CallModeSchema>;

export const OutboundConfigSchema = z
  .object({
    /** Default call mode for outbound calls */
    defaultMode: CallModeSchema.default("notify"),
    /** Seconds to wait after TTS before auto-hangup in notify mode */
    notifyHangupDelaySec: z.number().int().nonnegative().default(3),
  })
  .strict()
  .default({ defaultMode: "notify", notifyHangupDelaySec: 3 });
export type OutboundConfig = z.infer<typeof OutboundConfigSchema>;

// -----------------------------------------------------------------------------
// Streaming Configuration (OpenAI Realtime STT)
// -----------------------------------------------------------------------------

export const VoiceCallStreamingConfigSchema = z
  .object({
    /** Enable real-time audio streaming (requires WebSocket support) */
    enabled: z.boolean().default(false),
    /** STT provider for real-time transcription */
    sttProvider: z.enum(["openai-realtime"]).default("openai-realtime"),
    /** OpenAI API key for Realtime API (uses OPENAI_API_KEY env if not set) */
    openaiApiKey: z.string().min(1).optional(),
    /** OpenAI transcription model (default: gpt-4o-transcribe) */
    sttModel: z.string().min(1).default("gpt-4o-transcribe"),
    /** VAD silence duration in ms before considering speech ended */
    silenceDurationMs: z.number().int().positive().default(800),
    /** VAD threshold 0-1 (higher = less sensitive) */
    vadThreshold: z.number().min(0).max(1).default(0.5),
    /** WebSocket path for media stream connections */
    streamPath: z.string().min(1).default("/voice/stream"),
  })
  .strict()
  .default({
    enabled: false,
    sttProvider: "openai-realtime",
    sttModel: "gpt-4o-transcribe",
    silenceDurationMs: 800,
    vadThreshold: 0.5,
    streamPath: "/voice/stream",
  });
export type VoiceCallStreamingConfig = z.infer<
  typeof VoiceCallStreamingConfigSchema
>;

// -----------------------------------------------------------------------------
// Main Voice Call Configuration
// -----------------------------------------------------------------------------

export const VoiceCallConfigSchema = z
  .object({
  /** Enable voice call functionality */
  enabled: z.boolean().default(false),

  /** Active provider (telnyx, twilio, plivo, or mock) */
  provider: z.enum(["telnyx", "twilio", "plivo", "mock"]).optional(),

  /** Telnyx-specific configuration */
  telnyx: TelnyxConfigSchema.optional(),

  /** Twilio-specific configuration */
  twilio: TwilioConfigSchema.optional(),

  /** Plivo-specific configuration */
  plivo: PlivoConfigSchema.optional(),

  /** Phone number to call from (E.164) */
  fromNumber: E164Schema.optional(),

  /** Default phone number to call (E.164) */
  toNumber: E164Schema.optional(),

  /** Inbound call policy */
  inboundPolicy: InboundPolicySchema.default("disabled"),

  /** Allowlist of phone numbers for inbound calls (E.164) */
  allowFrom: z.array(E164Schema).default([]),

  /** Greeting message for inbound calls */
  inboundGreeting: z.string().optional(),

  /** Outbound call configuration */
  outbound: OutboundConfigSchema,

  /** Maximum call duration in seconds */
  maxDurationSeconds: z.number().int().positive().default(300),

  /** Silence timeout for end-of-speech detection (ms) */
  silenceTimeoutMs: z.number().int().positive().default(800),

  /** Timeout for user transcript (ms) */
  transcriptTimeoutMs: z.number().int().positive().default(180000),

  /** Ring timeout for outbound calls (ms) */
  ringTimeoutMs: z.number().int().positive().default(30000),

  /** Maximum concurrent calls */
  maxConcurrentCalls: z.number().int().positive().default(1),

  /** Webhook server configuration */
  serve: VoiceCallServeConfigSchema,

  /** Tailscale exposure configuration (legacy, prefer tunnel config) */
  tailscale: VoiceCallTailscaleConfigSchema,

  /** Tunnel configuration (unified ngrok/tailscale) */
  tunnel: VoiceCallTunnelConfigSchema,

  /** Real-time audio streaming configuration */
  streaming: VoiceCallStreamingConfigSchema,

  /** Public webhook URL override (if set, bypasses tunnel auto-detection) */
  publicUrl: z.string().url().optional(),

  /** Skip webhook signature verification (development only, NOT for production) */
  skipSignatureVerification: z.boolean().default(false),

  /** STT configuration */
  stt: SttConfigSchema,

  /** TTS override (deep-merges with core messages.tts) */
  tts: TtsConfigSchema,

  /** Store path for call logs */
  store: z.string().optional(),

  /** Model for generating voice responses (e.g., "anthropic/claude-sonnet-4", "openai/gpt-4o") */
  responseModel: z.string().default("openai/gpt-4o-mini"),

  /** System prompt for voice responses */
  responseSystemPrompt: z.string().optional(),

  /** Timeout for response generation in ms (default 30s) */
  responseTimeoutMs: z.number().int().positive().default(30000),
})
  .strict();

export type VoiceCallConfig = z.infer<typeof VoiceCallConfigSchema>;

// -----------------------------------------------------------------------------
// Configuration Helpers
// -----------------------------------------------------------------------------

/**
 * Validate that the configuration has all required fields for the selected provider.
 */
export function validateProviderConfig(config: VoiceCallConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.enabled) {
    return { valid: true, errors: [] };
  }

  if (!config.provider) {
    errors.push("plugins.entries.voice-call.config.provider is required");
  }

  if (!config.fromNumber && config.provider !== "mock") {
    errors.push("plugins.entries.voice-call.config.fromNumber is required");
  }

  if (config.provider === "telnyx") {
    if (!config.telnyx?.apiKey) {
      errors.push(
        "plugins.entries.voice-call.config.telnyx.apiKey is required (or set TELNYX_API_KEY env)",
      );
    }
    if (!config.telnyx?.connectionId) {
      errors.push(
        "plugins.entries.voice-call.config.telnyx.connectionId is required (or set TELNYX_CONNECTION_ID env)",
      );
    }
  }

  if (config.provider === "twilio") {
    if (!config.twilio?.accountSid) {
      errors.push(
        "plugins.entries.voice-call.config.twilio.accountSid is required (or set TWILIO_ACCOUNT_SID env)",
      );
    }
    if (!config.twilio?.authToken) {
      errors.push(
        "plugins.entries.voice-call.config.twilio.authToken is required (or set TWILIO_AUTH_TOKEN env)",
      );
    }
  }

  if (config.provider === "plivo") {
    if (!config.plivo?.authId) {
      errors.push(
        "plugins.entries.voice-call.config.plivo.authId is required (or set PLIVO_AUTH_ID env)",
      );
    }
    if (!config.plivo?.authToken) {
      errors.push(
        "plugins.entries.voice-call.config.plivo.authToken is required (or set PLIVO_AUTH_TOKEN env)",
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
