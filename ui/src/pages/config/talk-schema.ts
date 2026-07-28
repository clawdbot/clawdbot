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

/** The three talk.realtime keys the curated rows lift out of the raw form. */
export function resolveTalkRealtimeSelection(
  configObject: Record<string, unknown>,
): TalkRealtimeSelection {
  const realtime = readRecord(readRecord(configObject.talk)?.realtime);
  return {
    provider: readTrimmedString(realtime?.provider),
    model: readTrimmedString(realtime?.model),
    speakerVoice:
      readTrimmedString(realtime?.speakerVoice) ?? readTrimmedString(realtime?.speakerVoiceId),
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
