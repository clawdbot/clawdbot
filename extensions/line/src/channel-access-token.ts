export function resolveLineChannelAccessToken(
  explicit: string | undefined,
  params: { accountId: string; channelAccessToken: string },
): string {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (!params.channelAccessToken) {
    throw new Error(
      `LINE channel access token missing for account "${params.accountId}" (set channels.line.channelAccessToken or LINE_CHANNEL_ACCESS_TOKEN).`,
    );
  }
  return params.channelAccessToken.trim();
}
