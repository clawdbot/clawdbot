// Config-facts module for the curated Talk settings page. No lit imports: like
// memory-schema.ts, settings search evaluates these facts from the startup
// chunk and must not pull settings UI code in with them.

export type TalkRealtimeSelection = {
  provider: string | null;
  model: string | null;
  speakerVoice: string | null;
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
 * Effective talk.realtime picks as the gateway resolves them: top-level keys
 * override, then the selected provider's own entry supplies the fallback
 * (mirrors buildTalkRealtimeConfig's precedence). Without the fallback an
 * existing provider-level GPT-Live config would render as "Provider default"
 * and hide the GPT-Live row.
 */
export function resolveTalkRealtimeSelection(
  configObject: Record<string, unknown>,
): TalkRealtimeSelection {
  const realtime = readRecord(readRecord(configObject.talk)?.realtime);
  const providerConfigs = readRecord(realtime?.providers) ?? {};
  const providerIds = Object.keys(providerConfigs);
  const provider =
    readTrimmedString(realtime?.provider) ?? (providerIds.length === 1 ? providerIds[0] : null);
  const providerEntry = provider ? readRecord(providerConfigs[provider]) : undefined;
  return {
    provider: readTrimmedString(realtime?.provider),
    model: readTrimmedString(realtime?.model) ?? readTrimmedString(providerEntry?.model),
    speakerVoice:
      readTrimmedString(realtime?.speakerVoice) ??
      readTrimmedString(realtime?.speakerVoiceId) ??
      readTrimmedString(providerEntry?.speakerVoice) ??
      readTrimmedString(providerEntry?.voice),
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
