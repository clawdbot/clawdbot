import type { VoiceCallConfig } from "./config.js";
import { DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS } from "./realtime-defaults.js";

export function createVoiceCallBaseConfig(params?: {
  provider?: "telnyx" | "twilio" | "plivo" | "mock";
  tunnelProvider?: "none" | "ngrok";
}): VoiceCallConfig {
  return {
    enabled: true,
    provider: params?.provider ?? "mock",
    fromNumber: "+15550001234",
    inboundPolicy: "disabled",
    allowFrom: [],
    outbound: { defaultMode: "notify", notifyHangupDelaySec: 3 },
    maxDurationSeconds: 300,
    staleCallReaperSeconds: 600,
    silenceTimeoutMs: 800,
    transcriptTimeoutMs: 180000,
    ringTimeoutMs: 30000,
    maxConcurrentCalls: 1,
    serve: { port: 3334, bind: "127.0.0.1", path: "/voice/webhook" },
    tailscale: { mode: "off", path: "/voice/webhook" },
    tunnel: {
      provider: params?.tunnelProvider ?? "none",
      allowNgrokFreeTierLoopbackBypass: false,
    },
    webhookSecurity: {
      allowedHosts: [],
      trustForwardingHeaders: false,
      trustedProxyIPs: [],
    },
    streaming: {
      enabled: false,
      providers: {
        openai: {
          model: "gpt-4o-transcribe",
          silenceDurationMs: 800,
          vadThreshold: 0.5,
        },
      },
      streamPath: "/voice/stream",
      preStartTimeoutMs: 5000,
      maxPendingConnections: 32,
      maxPendingConnectionsPerIp: 4,
      maxConnections: 128,
    },
    realtime: {
      enabled: false,
      streamPath: "/voice/stream/realtime",
      instructions: DEFAULT_VOICE_CALL_REALTIME_INSTRUCTIONS,
      toolPolicy: "safe-read-only",
      tools: [],
      fastContext: {
        enabled: false,
        timeoutMs: 800,
        maxResults: 3,
        sources: ["memory", "sessions"],
        fallbackToConsult: false,
      },
      providers: {},
    },
    skipSignatureVerification: false,
    tts: {
      provider: "openai",
      providers: {
        openai: { model: "gpt-4o-mini-tts", voice: "coral" },
      },
    },
    responseTimeoutMs: 30000,
  };
}
