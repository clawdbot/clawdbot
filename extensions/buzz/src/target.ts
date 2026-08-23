export const BUZZ_CHANNEL_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/u;

export function normalizeBuzzTarget(target: string): string {
  return target
    .trim()
    .replace(/^buzz:/iu, "")
    .replace(/^channel:/iu, "");
}

export function parseBuzzTarget(target: string): string {
  const channelId = normalizeBuzzTarget(target);
  if (!BUZZ_CHANNEL_ID_PATTERN.test(channelId)) {
    throw new Error("Buzz target must be a channel UUID");
  }
  return channelId.toLowerCase();
}

export function isConfiguredBuzzChannel(
  configuredChannelIds: ReadonlySet<string>,
  channelId: string,
): boolean {
  try {
    return configuredChannelIds.has(parseBuzzTarget(channelId));
  } catch {
    return false;
  }
}

export function buildBuzzTarget(channelId: string): string {
  return `buzz:${parseBuzzTarget(channelId)}`;
}

export function looksLikeBuzzTarget(target: string): boolean {
  try {
    parseBuzzTarget(target);
    return true;
  } catch {
    return false;
  }
}
