import type { TranscriptSourceLocator } from "./provider-types.js";

/** Strip invitation credentials from meeting locators before persistence/provider handoff. */
export function sanitizeTranscriptSourceLocator(
  source: TranscriptSourceLocator,
): TranscriptSourceLocator {
  if (!source.meetingUrl) {
    return source;
  }
  const { meetingUrl: _meetingUrl, ...rest } = source;
  try {
    const url = new URL(source.meetingUrl);
    return { ...rest, meetingUrl: `${url.origin}${url.pathname}` };
  } catch {
    return rest;
  }
}
