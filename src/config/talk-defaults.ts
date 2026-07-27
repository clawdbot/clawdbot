/** Platform-specific silence windows for talk/voice turn segmentation. */
const TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM = {
  macos: 700,
  android: 700,
  ios: 900,
} as const;

/**
 * Grace window a realtime Talk consult keeps listening for real final text after an
 * empty `final` chat event before it answers with the "no text" placeholder. Agent
 * runs routinely deliver their text tens of seconds after that empty final, and the
 * placeholder is spoken aloud, so a short window turns every slow answer into a
 * double reply.
 */
export const DEFAULT_TALK_EMPTY_FINAL_GRACE_MS = 60_000;

/** Formats the talk silence defaults for config help text. */
export function describeTalkSilenceTimeoutDefaults(): string {
  const macos = TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM.macos;
  const ios = TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM.ios;
  return `${macos} ms on macOS and Android, ${ios} ms on iOS`;
}
