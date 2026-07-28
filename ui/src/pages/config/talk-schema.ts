// Config-facts module for the curated Talk settings page. No lit imports: like
// memory-schema.ts, settings search evaluates these facts from the startup
// chunk and must not pull settings UI code in with them.

/** Normalized model/voice pair from one `talk.realtime.providers.<id>` entry. */
type TalkProviderEntryValues = {
  model: string | null;
  speakerVoice: string | null;
};

export type TalkRealtimeSelection = {
  /** Raw configured `talk.realtime.provider`, possibly an alias. */
  provider: string | null;
  /** Top-level `talk.realtime.model` override only; provider fallback is resolved in the view. */
  model: string | null;
  /** Top-level `speakerVoice` / `speakerVoiceId` override only. */
  speakerVoice: string | null;
  /** Raw configured `talk.realtime.transport`. */
  transport: string | null;
  /** Per-provider fallback values keyed by the raw config map key. */
  providerEntries: Record<string, TalkProviderEntryValues>;
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Raw talk.realtime picks plus each provider entry's fallback values. Which
 * entry is effective depends on the catalog's active provider and alias map,
 * so that resolution lives in the view (talk.ts), not here.
 */
export function resolveTalkRealtimeSelection(
  configObject: Record<string, unknown>,
): TalkRealtimeSelection {
  const realtime = readRecord(readRecord(configObject.talk)?.realtime);
  const providerConfigs = readRecord(realtime?.providers) ?? {};
  const providerEntries: Record<string, TalkProviderEntryValues> = {};
  for (const [key, value] of Object.entries(providerConfigs)) {
    const entry = readRecord(value);
    if (!entry) {
      continue;
    }
    providerEntries[key] = {
      model: readTrimmedString(entry.model),
      // Provider-level `voice` is a provider-owned legacy alias for
      // speakerVoice (each provider normalizes it); read both for display.
      speakerVoice: readTrimmedString(entry.speakerVoice) ?? readTrimmedString(entry.voice),
    };
  }
  return {
    provider: readTrimmedString(realtime?.provider),
    model: readTrimmedString(realtime?.model),
    speakerVoice:
      readTrimmedString(realtime?.speakerVoice) ?? readTrimmedString(realtime?.speakerVoiceId),
    transport: readTrimmedString(realtime?.transport),
    providerEntries,
  };
}

/**
 * Mirrors the server-side gpt-live prefix contract
 * (extensions/openai/realtime-quicksilver.ts); the UI only uses it to decide
 * whether to show the ChatGPT sign-in hint, never to gate a session.
 */
export function isTalkGptLiveModel(model: string | null): boolean {
  return model !== null && model.toLowerCase().startsWith("gpt-live");
}
