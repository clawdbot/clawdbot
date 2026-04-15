type LineCredentialAccount = {
  channelAccessToken?: string;
  channelSecret?: string;
};

export function hasLineCredentials(account: LineCredentialAccount): boolean {
  return Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim());
}

export function parseLineAllowFromId(raw: string): string | null {
  const trimmed = raw.trim().replace(/^line:(?:user:)?/i, "");
  if (!/^U[a-f0-9]{32}$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}
