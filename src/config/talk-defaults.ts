/** Platform-specific silence windows for talk/voice turn segmentation. */
export const TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM = {
  macos: 700,
  android: 700,
  ios: 900,
} as const;

/** Formats the talk silence defaults for config help text. */
export function describeTalkSilenceTimeoutDefaults(): string {
  const macos = TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM.macos;
  const ios = TALK_SILENCE_TIMEOUT_MS_BY_PLATFORM.ios;
  return `${macos} ms on macOS and Android, ${ios} ms on iOS`;
}
