// Voice Call setup helper migrates legacy config to the canonical schema.
import {
  asFiniteNumber,
  asOptionalRecord,
  readStringField,
} from "openclaw/plugin-sdk/string-coerce-runtime";

/** Read finite numeric config values. */
function getNumber(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  return asFiniteNumber(obj?.[key]);
}

/** Merge legacy provider-specific values into the canonical providers map. */
function mergeProviderConfig(
  providersValue: unknown,
  providerId: string,
  compatValues: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (Object.keys(compatValues).length === 0) {
    return asOptionalRecord(providersValue);
  }

  const providers = asOptionalRecord(providersValue) ?? {};
  const existing = asOptionalRecord(providers[providerId]) ?? {};
  return {
    ...providers,
    [providerId]: {
      ...existing,
      ...compatValues,
    },
  };
}

/** Migrate legacy voice-call config input to the current canonical shape. */
export function migrateVoiceCallLegacyConfigInput(params: {
  value: unknown;
  configPathPrefix?: string;
}): {
  config: Record<string, unknown>;
  changes: string[];
} {
  const raw = asOptionalRecord(params.value) ?? {};
  const realtime = asOptionalRecord(raw.realtime);
  const realtimeAgentContext = asOptionalRecord(realtime?.agentContext);
  const twilio = asOptionalRecord(raw.twilio);
  const streaming = asOptionalRecord(raw.streaming);
  const configPathPrefix = params.configPathPrefix ?? "plugins.entries.voice-call.config";

  const legacyStreamingOpenAICompat: Record<string, unknown> = {};
  const streamingOpenAIApiKey = readStringField(streaming, "openaiApiKey");
  if (streamingOpenAIApiKey) {
    legacyStreamingOpenAICompat.apiKey = streamingOpenAIApiKey;
  }
  const streamingSttModel = readStringField(streaming, "sttModel");
  if (streamingSttModel) {
    legacyStreamingOpenAICompat.model = streamingSttModel;
  }
  const streamingSilenceDurationMs = getNumber(streaming, "silenceDurationMs");
  if (streamingSilenceDurationMs !== undefined) {
    legacyStreamingOpenAICompat.silenceDurationMs = streamingSilenceDurationMs;
  }
  const streamingVadThreshold = getNumber(streaming, "vadThreshold");
  if (streamingVadThreshold !== undefined) {
    legacyStreamingOpenAICompat.vadThreshold = streamingVadThreshold;
  }
  const streamingProvider = readStringField(streaming, "provider");
  const legacyStreamingProvider = readStringField(streaming, "sttProvider");

  const normalizedStreaming: Record<string, unknown> | undefined = streaming
    ? {
        ...streaming,
        provider: streamingProvider ?? legacyStreamingProvider,
        providers: mergeProviderConfig(streaming.providers, "openai", legacyStreamingOpenAICompat),
      }
    : undefined;

  if (normalizedStreaming) {
    delete normalizedStreaming.sttProvider;
    delete normalizedStreaming.openaiApiKey;
    delete normalizedStreaming.sttModel;
    delete normalizedStreaming.silenceDurationMs;
    delete normalizedStreaming.vadThreshold;
  }

  const normalizedTwilio = twilio
    ? {
        ...twilio,
      }
    : undefined;
  if (normalizedTwilio) {
    delete normalizedTwilio.from;
  }

  const normalizedRealtimeAgentContext = realtimeAgentContext
    ? {
        ...realtimeAgentContext,
      }
    : undefined;
  if (normalizedRealtimeAgentContext) {
    delete normalizedRealtimeAgentContext.includeSystemPrompt;
  }

  const normalizedRealtime = realtime
    ? {
        ...realtime,
        agentContext: normalizedRealtimeAgentContext ?? realtime.agentContext,
      }
    : undefined;

  const config = {
    ...raw,
    provider: raw.provider === "log" ? "mock" : raw.provider,
    fromNumber: raw.fromNumber ?? (typeof twilio?.from === "string" ? twilio.from : undefined),
    twilio: normalizedTwilio,
    streaming: normalizedStreaming,
    realtime: normalizedRealtime,
  };

  const changes: string[] = [];
  if (raw.provider === "log") {
    changes.push(`Moved ${configPathPrefix}.provider "log" → "mock".`);
  }
  if (typeof twilio?.from === "string" && typeof raw.fromNumber !== "string") {
    changes.push(`Moved ${configPathPrefix}.twilio.from → ${configPathPrefix}.fromNumber.`);
  }
  if (typeof streaming?.sttProvider === "string") {
    changes.push(
      `Moved ${configPathPrefix}.streaming.sttProvider → ${configPathPrefix}.streaming.provider.`,
    );
  }
  if (typeof streaming?.openaiApiKey === "string") {
    changes.push(
      `Moved ${configPathPrefix}.streaming.openaiApiKey → ${configPathPrefix}.streaming.providers.openai.apiKey.`,
    );
  }
  if (typeof streaming?.sttModel === "string") {
    changes.push(
      `Moved ${configPathPrefix}.streaming.sttModel → ${configPathPrefix}.streaming.providers.openai.model.`,
    );
  }
  if (getNumber(streaming, "silenceDurationMs") !== undefined) {
    changes.push(
      `Moved ${configPathPrefix}.streaming.silenceDurationMs → ${configPathPrefix}.streaming.providers.openai.silenceDurationMs.`,
    );
  } else if (typeof streaming?.silenceDurationMs === "number") {
    changes.push(`Removed invalid ${configPathPrefix}.streaming.silenceDurationMs.`);
  }
  if (getNumber(streaming, "vadThreshold") !== undefined) {
    changes.push(
      `Moved ${configPathPrefix}.streaming.vadThreshold → ${configPathPrefix}.streaming.providers.openai.vadThreshold.`,
    );
  } else if (typeof streaming?.vadThreshold === "number") {
    changes.push(`Removed invalid ${configPathPrefix}.streaming.vadThreshold.`);
  }
  if (realtimeAgentContext && Object.hasOwn(realtimeAgentContext, "includeSystemPrompt")) {
    changes.push(`Removed ${configPathPrefix}.realtime.agentContext.includeSystemPrompt.`);
  }

  return { config, changes };
}
