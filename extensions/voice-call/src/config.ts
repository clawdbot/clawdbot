import { z } from "openclaw/plugin-sdk/zod";
import { TtsAutoSchema, TtsConfigSchema, TtsModeSchema, TtsProviderSchema } from "../api.js";
import { deepMergeDefined } from "./deep-merge.js";

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
export const InboundPolicySchema = z.enum(["disabled", "allowlist", "pairing", "open"]);
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

export { TtsAutoSchema, TtsConfigSchema, TtsModeSchema, TtsProviderSchema };
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
export type VoiceCallTailscaleConfig = z.infer<typeof VoiceCallTailscaleConfigSchema>;

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
    provider: z.enum(["none", "ngrok", "tailscale-serve", "tailscale-funnel"]).default("none"),
    /** ngrok auth token (optional, enables longer sessions and more features) */
    ngrokAuthToken: z.string().min(1).optional(),
    /** ngrok custom domain (paid feature, e.g., "myapp.ngrok.io") */
    ngrokDomain: z.string().min(1).optional(),
    /**
     * Allow ngrok free tier compatibility mode.
     * When true, forwarded headers may be trusted for loopback requests
     * to reconstruct the public ngrok URL used for signing.
     *
     * IMPORTANT: This does NOT bypass signature verification.
     */
    allowNgrokFreeTierLoopbackBypass: z.boolean().default(false),
  })
  .strict()
  .default({ provider: "none", allowNgrokFreeTierLoopbackBypass: false });
export type VoiceCallTunnelConfig = z.infer<typeof VoiceCallTunnelConfigSchema>;

// -----------------------------------------------------------------------------
// Webhook Security Configuration
// -----------------------------------------------------------------------------

export const VoiceCallWebhookSecurityConfigSchema = z
  .object({
    /**
     * Allowed hostnames for webhook URL reconstruction.
     * Only these hosts are accepted from forwarding headers.
     */
    allowedHosts: z.array(z.string().min(1)).default([]),
    /**
     * Trust X-Forwarded-* headers without a hostname allowlist.
     * WARNING: Only enable if you trust your proxy configuration.
     */
    trustForwardingHeaders: z.boolean().default(false),
    /**
     * Trusted proxy IP addresses. Forwarded headers are only trusted when
     * the remote IP matches one of these addresses.
     */
    trustedProxyIPs: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .default({ allowedHosts: [], trustForwardingHeaders: false, trustedProxyIPs: [] });
export type WebhookSecurityConfig = z.infer<typeof VoiceCallWebhookSecurityConfigSchema>;

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
// Realtime Voice Configuration
// -----------------------------------------------------------------------------

export const RealtimeToolSchema = z
  .object({
    type: z.literal("function"),
    name: z.string().min(1),
    description: z.string(),
    parameters: z.object({
      type: z.literal("object"),
      properties: z.record(z.string(), z.unknown()),
      required: z.array(z.string()).optional(),
    }),
  })
  .strict();
export type RealtimeToolConfig = z.infer<typeof RealtimeToolSchema>;

export const VoiceCallRealtimeProvidersConfigSchema = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .default({});
export type VoiceCallRealtimeProvidersConfig = z.infer<
  typeof VoiceCallRealtimeProvidersConfigSchema
>;

export const VoiceCallStreamingProvidersConfigSchema = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .default({});
export type VoiceCallStreamingProvidersConfig = z.infer<
  typeof VoiceCallStreamingProvidersConfigSchema
>;

export const VoiceCallRealtimeConfigSchema = z
  .object({
    /** Enable realtime voice-to-voice mode. */
    enabled: z.boolean().default(false),
    /** Provider id from registered realtime voice providers. */
    provider: z.string().min(1).optional(),
    /** Optional override for the local WebSocket route path. */
    streamPath: z.string().min(1).optional(),
    /** System instructions passed to the realtime provider. */
    instructions: z.string().optional(),
    /** Tool definitions exposed to the realtime provider. */
    tools: z.array(RealtimeToolSchema).default([]),
    /** Provider-owned raw config blobs keyed by provider id. */
    providers: VoiceCallRealtimeProvidersConfigSchema,
  })
  .strict()
  .default({ enabled: false, tools: [], providers: {} });
export type VoiceCallRealtimeConfig = z.infer<typeof VoiceCallRealtimeConfigSchema>;

// -----------------------------------------------------------------------------
// Streaming Configuration (Realtime Transcription)
// -----------------------------------------------------------------------------

export const VoiceCallStreamingConfigSchema = z
  .object({
    /** Enable real-time audio streaming (requires WebSocket support) */
    enabled: z.boolean().default(false),
    /** Provider id from registered realtime transcription providers. */
    provider: z.string().min(1).optional(),
    /** WebSocket path for media stream connections */
    streamPath: z.string().min(1).default("/voice/stream"),
    /** Provider-owned raw config blobs keyed by provider id. */
    providers: VoiceCallStreamingProvidersConfigSchema,
    /**
     * Close unauthenticated media stream sockets if no valid `start` frame arrives in time.
     * Protects against pre-auth idle connection hold attacks.
     */
    preStartTimeoutMs: z.number().int().positive().default(5000),
    /** Maximum number of concurrently pending (pre-start) media stream sockets. */
    maxPendingConnections: z.number().int().positive().default(32),
    /** Maximum pending media stream sockets per source IP. */
    maxPendingConnectionsPerIp: z.number().int().positive().default(4),
    /** Hard cap for all open media stream sockets (pending + active). */
    maxConnections: z.number().int().positive().default(128),
  })
  .strict()
  .default({
    enabled: false,
    streamPath: "/voice/stream",
    providers: {},
    preStartTimeoutMs: 5000,
    maxPendingConnections: 32,
    maxPendingConnectionsPerIp: 4,
    maxConnections: 128,
  });
export type VoiceCallStreamingConfig = z.infer<typeof VoiceCallStreamingConfigSchema>;

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

    /**
     * Maximum age of a call in seconds before it is automatically reaped.
     * Catches calls stuck in unexpected states (e.g., notify-mode calls that
     * never receive a terminal webhook). Set to 0 to disable.
     * Default: 0 (disabled). Recommended: 120-300 for production.
     */
    staleCallReaperSeconds: z.number().int().nonnegative().default(0),

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

    /** Webhook signature reconstruction and proxy trust configuration */
    webhookSecurity: VoiceCallWebhookSecurityConfigSchema,

    /** Real-time audio streaming configuration */
    streaming: VoiceCallStreamingConfigSchema,

    /** Realtime voice-to-voice configuration */
    realtime: VoiceCallRealtimeConfigSchema,

    /** Public webhook URL override (if set, bypasses tunnel auto-detection) */
    publicUrl: z.string().url().optional(),

    /** Skip webhook signature verification (development only, NOT for production) */
    skipSignatureVerification: z.boolean().default(false),

    /** TTS override (deep-merges with core messages.tts) */
    tts: TtsConfigSchema,

    /** Store path for call logs */
    store: z.string().optional(),

    /** Optional model override for generating voice responses. */
    responseModel: z.string().optional(),

    /** System prompt for voice responses */
    responseSystemPrompt: z.string().optional(),

    /** Timeout for response generation in ms (default 30s) */
    responseTimeoutMs: z.number().int().positive().default(30000),
  })
  .strict();

export type VoiceCallConfig = z.infer<typeof VoiceCallConfigSchema>;
type DeepPartial<T> =
  T extends Array<infer U>
    ? DeepPartial<U>[]
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;
export type VoiceCallConfigInput = DeepPartial<VoiceCallConfig>;

// -----------------------------------------------------------------------------
// Configuration Helpers
// -----------------------------------------------------------------------------

const DEFAULT_VOICE_CALL_CONFIG = VoiceCallConfigSchema.parse({});

function cloneDefaultVoiceCallConfig(): VoiceCallConfig {
  return structuredClone(DEFAULT_VOICE_CALL_CONFIG);
}

function normalizeWebhookLikePath(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) {
    return "/";
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (prefixed === "/") {
    return prefixed;
  }
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

function defaultRealtimeStreamPathForServePath(servePath: string): string {
  const normalized = normalizeWebhookLikePath(servePath);
  if (normalized.endsWith("/webhook")) {
    return `${normalized.slice(0, -"/webhook".length)}/stream/realtime`;
  }
  if (normalized === "/") {
    return "/voice/stream/realtime";
  }
  return `${normalized}/stream/realtime`;
}

function normalizeVoiceCallTtsConfig(
  defaults: VoiceCallTtsConfig,
  overrides: DeepPartial<NonNullable<VoiceCallTtsConfig>> | undefined,
): VoiceCallTtsConfig {
  if (!defaults && !overrides) {
    return undefined;
  }

  return TtsConfigSchema.parse(deepMergeDefined(defaults ?? {}, overrides ?? {}));
}

function sanitizeVoiceCallProviderConfigs(
  value: Record<string, Record<string, unknown> | undefined> | undefined,
): Record<string, Record<string, unknown>> {
  if (!value) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, Record<string, unknown>] => entry[1] !== undefined,
    ),
  );
}

export function normalizeVoiceCallConfig(config: VoiceCallConfigInput): VoiceCallConfig {
  const defaults = cloneDefaultVoiceCallConfig();
  const serve = { ...defaults.serve, ...config.serve };
  const streamingProvider = config.streaming?.provider;
  const streamingProviders = sanitizeVoiceCallProviderConfigs(
    config.streaming?.providers ?? defaults.streaming.providers,
  );
  const realtimeProvider = config.realtime?.provider ?? defaults.realtime.provider;
  const realtimeProviders = sanitizeVoiceCallProviderConfigs(
    config.realtime?.providers ?? defaults.realtime.providers,
  );
  return {
    ...defaults,
    ...config,
    allowFrom: config.allowFrom ?? defaults.allowFrom,
    outbound: { ...defaults.outbound, ...config.outbound },
    serve,
    tailscale: { ...defaults.tailscale, ...config.tailscale },
    tunnel: { ...defaults.tunnel, ...config.tunnel },
    webhookSecurity: {
      ...defaults.webhookSecurity,
      ...config.webhookSecurity,
      allowedHosts: config.webhookSecurity?.allowedHosts ?? defaults.webhookSecurity.allowedHosts,
      trustedProxyIPs:
        config.webhookSecurity?.trustedProxyIPs ?? defaults.webhookSecurity.trustedProxyIPs,
    },
    streaming: {
      ...defaults.streaming,
      ...config.streaming,
      provider: streamingProvider,
      providers: streamingProviders,
    },
    realtime: {
      ...defaults.realtime,
      ...config.realtime,
      provider: realtimeProvider,
      streamPath:
        config.realtime?.streamPath ??
        defaultRealtimeStreamPathForServePath(serve.path ?? defaults.serve.path),
      tools:
        (config.realtime?.tools as RealtimeToolConfig[] | undefined) ?? defaults.realtime.tools,
      providers: realtimeProviders,
    },
    tts: normalizeVoiceCallTtsConfig(defaults.tts, config.tts),
  };
}

/**
 * Resolves the configuration by merging environment variables into missing fields.
 * Returns a new configuration object with environment variables applied.
 */
export function resolveVoiceCallConfig(config: VoiceCallConfigInput): VoiceCallConfig {
  const resolved = normalizeVoiceCallConfig(config);

  // Telnyx
  if (resolved.provider === "telnyx") {
    resolved.telnyx = resolved.telnyx ?? {};
    resolved.telnyx.apiKey = resolved.telnyx.apiKey ?? process.env.TELNYX_API_KEY;
    resolved.telnyx.connectionId = resolved.telnyx.connectionId ?? process.env.TELNYX_CONNECTION_ID;
    resolved.telnyx.publicKey = resolved.telnyx.publicKey ?? process.env.TELNYX_PUBLIC_KEY;
  }

  // Twilio
  if (resolved.provider === "twilio") {
    resolved.fromNumber = resolved.fromNumber ?? process.env.TWILIO_FROM_NUMBER;
    resolved.twilio = resolved.twilio ?? {};
    resolved.twilio.accountSid = resolved.twilio.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
    resolved.twilio.authToken = resolved.twilio.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  }

  // Plivo
  if (resolved.provider === "plivo") {
    resolved.plivo = resolved.plivo ?? {};
    resolved.plivo.authId = resolved.plivo.authId ?? process.env.PLIVO_AUTH_ID;
    resolved.plivo.authToken = resolved.plivo.authToken ?? process.env.PLIVO_AUTH_TOKEN;
  }

  // Tunnel Config
  resolved.tunnel = resolved.tunnel ?? {
    provider: "none",
    allowNgrokFreeTierLoopbackBypass: false,
  };
  resolved.tunnel.allowNgrokFreeTierLoopbackBypass =
    resolved.tunnel.allowNgrokFreeTierLoopbackBypass ?? false;
  resolved.tunnel.ngrokAuthToken = resolved.tunnel.ngrokAuthToken ?? process.env.NGROK_AUTHTOKEN;
  resolved.tunnel.ngrokDomain = resolved.tunnel.ngrokDomain ?? process.env.NGROK_DOMAIN;

  // Webhook Security Config
  resolved.webhookSecurity = resolved.webhookSecurity ?? {
    allowedHosts: [],
    trustForwardingHeaders: false,
    trustedProxyIPs: [],
  };
  resolved.webhookSecurity.allowedHosts = resolved.webhookSecurity.allowedHosts ?? [];
  resolved.webhookSecurity.trustForwardingHeaders =
    resolved.webhookSecurity.trustForwardingHeaders ?? false;
  resolved.webhookSecurity.trustedProxyIPs = resolved.webhookSecurity.trustedProxyIPs ?? [];

  return normalizeVoiceCallConfig(resolved);
}

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
    errors.push(
      config.provider === "twilio"
        ? "plugins.entries.voice-call.config.fromNumber is required (or set TWILIO_FROM_NUMBER env)"
        : "plugins.entries.voice-call.config.fromNumber is required",
    );
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
    if (!config.skipSignatureVerification && !config.telnyx?.publicKey) {
      errors.push(
        "plugins.entries.voice-call.config.telnyx.publicKey is required (or set TELNYX_PUBLIC_KEY env)",
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

  if (config.realtime.enabled && config.inboundPolicy === "disabled") {
    errors.push(
      'plugins.entries.voice-call.config.inboundPolicy must not be "disabled" when realtime.enabled is true',
    );
  }

  if (config.realtime.enabled && config.streaming.enabled) {
    errors.push(
      "plugins.entries.voice-call.config.realtime.enabled and plugins.entries.voice-call.config.streaming.enabled cannot both be true",
    );
  }

  if (config.realtime.enabled && config.provider && config.provider !== "twilio") {
    errors.push(
      'plugins.entries.voice-call.config.provider must be "twilio" when realtime.enabled is true',
    );
  }

  return { valid: errors.length === 0, errors };
}
