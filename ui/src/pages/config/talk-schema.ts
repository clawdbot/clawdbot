// Config-facts module for the curated Talk settings page. No lit imports: like
// memory-schema.ts, settings search evaluates these facts from the startup
// chunk and must not pull settings UI code in with them.
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString as readTrimmedString } from "@openclaw/normalization-core/string-coerce";

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
  /** Normalized configured `talk.realtime.consultRouting`. */
  consultRouting: string | null;
  /** Per-provider fallback values keyed by the raw config map key. */
  providerEntries: Record<string, TalkProviderEntryValues>;
};

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
    consultRouting: readTrimmedString(realtime?.consultRouting)?.toLowerCase() ?? null,
    providerEntries,
  };
}

/**
 * Mirrors the server-side gpt-live family contract
 * (extensions/openai/realtime-quicksilver.ts); the UI uses it for the ChatGPT
 * sign-in hint and to avoid retaining a transport the selected provider
 * positively rejects. It never gates a session.
 */
export function isTalkGptLiveModel(model: string | null): boolean {
  const normalized = model?.trim().toLowerCase();
  return normalized === "gpt-live" || normalized?.startsWith("gpt-live-") === true;
}

/** An empty or unavailable transport catalog is not evidence of incompatibility. */
export function talkProviderRejectsTransport(
  transports: readonly string[] | undefined,
  transport: string,
): boolean {
  return transports !== undefined && transports.length > 0 && !transports.includes(transport);
}
