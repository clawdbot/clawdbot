import { isDeepStrictEqual } from "node:util";
import { hashRuntimeConfigValue } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TranscriptsConfig } from "./config.js";

function withoutTitles(config: TranscriptsConfig | undefined) {
  return (
    config && {
      ...config,
      ...(config.autoStart && {
        autoStart: config.autoStart.map(({ title: _title, ...source }) => source),
      }),
    }
  );
}

/** Compare full source intent before reading titles, without borrowing new routing authority. */
export function hasSameTranscriptCaptureIntent(
  previous: TranscriptsConfig | undefined,
  candidate: TranscriptsConfig | undefined,
): boolean {
  return isDeepStrictEqual(withoutTitles(previous), withoutTitles(candidate));
}

/** Bounded process diagnostic correlation only, never admission or resume authority. */
export function transcriptCaptureConfigHash(config: TranscriptsConfig | undefined): string {
  return hashRuntimeConfigValue({ transcripts: withoutTitles(config) });
}

/** Compare authoritative config, including routing, credentials and full invitation URLs. */
export function isTranscriptTitleOnlyConfigChange(
  previous: OpenClawConfig | undefined,
  candidate: OpenClawConfig | undefined,
): boolean {
  if (!previous || !candidate || isDeepStrictEqual(previous.transcripts, candidate.transcripts)) {
    return false;
  }
  const captureConfig = ({ transcripts, meta, ...config }: OpenClawConfig) => {
    // Only writer bookkeeping is irrelevant to this reload decision. Other
    // metadata and every non-title config value retain their normal handling.
    const { lastTouchedVersion: _version, ...metadata } = meta ?? {};
    return { ...config, meta: metadata, transcripts: withoutTitles(transcripts) };
  };
  return isDeepStrictEqual(captureConfig(previous), captureConfig(candidate));
}
