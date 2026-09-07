// Voice Call setup helper migrates legacy config to the canonical schema.
import {
  asFiniteNumber,
  asOptionalRecord,
  readStringField,
} from "openclaw/plugin-sdk/string-coerce-runtime";

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
  const changes: string[] = [];

  if (raw.provider === "log") {
    changes.push(`Moved ${configPathPrefix}.provider "log" → "mock".`);
  }
  if (typeof twilio?.from === "string") {
    const source = `${configPathPrefix}.twilio.from`;
    const target = `${configPathPrefix}.fromNumber`;
    changes.push(
      raw.fromNumber != null
        ? `Removed ${source} (kept ${target}).`
        : `Moved ${source} → ${target}.`,
    );
  }

  const streamingProvider = readStringField(streaming, "provider");
  const legacyStreamingProvider = readStringField(streaming, "sttProvider");
  const normalizedStreaming: Record<string, unknown> | undefined = streaming
    ? { ...streaming, provider: streamingProvider ?? legacyStreamingProvider }
    : undefined;

  if (normalizedStreaming) {
    delete normalizedStreaming.sttProvider;
    if (legacyStreamingProvider !== undefined) {
      const source = `${configPathPrefix}.streaming.sttProvider`;
      const target = `${configPathPrefix}.streaming.provider`;
      changes.push(
        streamingProvider !== undefined
          ? `Removed ${source} (kept ${target}).`
          : `Moved ${source} → ${target}.`,
      );
    }

    for (const [legacyKey, canonicalKey, value] of [
      ["openaiApiKey", "apiKey", readStringField(streaming, "openaiApiKey")],
      ["sttModel", "model", readStringField(streaming, "sttModel")],
      ["silenceDurationMs", "silenceDurationMs", asFiniteNumber(streaming?.silenceDurationMs)],
      ["vadThreshold", "vadThreshold", asFiniteNumber(streaming?.vadThreshold)],
    ] as const) {
      if (!Object.hasOwn(normalizedStreaming, legacyKey)) {
        continue;
      }
      delete normalizedStreaming[legacyKey];
      const source = `${configPathPrefix}.streaming.${legacyKey}`;
      if (value === undefined || value === "") {
        changes.push(`Removed invalid ${source}.`);
        continue;
      }
      const providers = asOptionalRecord(normalizedStreaming.providers);
      const existing = asOptionalRecord(providers?.openai);
      const target = `${configPathPrefix}.streaming.providers.openai.${canonicalKey}`;
      // Transitional configs can retain stale credentials and tuning. Canonical
      // fields are authoritative, including SecretRefs, empty strings, and zero.
      if (existing?.[canonicalKey] !== undefined) {
        changes.push(`Removed ${source} (kept ${target}).`);
        continue;
      }
      normalizedStreaming.providers = {
        ...providers,
        openai: { ...existing, [canonicalKey]: value },
      };
      changes.push(`Moved ${source} → ${target}.`);
    }
  }

  const normalizedTwilio = twilio ? { ...twilio } : undefined;
  if (normalizedTwilio) {
    delete normalizedTwilio.from;
  }

  const normalizedRealtimeAgentContext = realtimeAgentContext
    ? { ...realtimeAgentContext }
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

  if (realtimeAgentContext && Object.hasOwn(realtimeAgentContext, "includeSystemPrompt")) {
    changes.push(`Removed ${configPathPrefix}.realtime.agentContext.includeSystemPrompt.`);
  }

  return { config, changes };
}
