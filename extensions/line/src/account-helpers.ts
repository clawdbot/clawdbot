// Line helper module supports account helpers behavior.
type LineCredentialAccount = {
  channelAccessToken?: string;
  channelSecret?: string;
  tokenStatus?: "available" | "configured_unavailable" | "missing";
  signingSecretStatus?: "available" | "configured_unavailable" | "missing";
};

export function hasLineCredentials(account: LineCredentialAccount): boolean {
  if (account.tokenStatus && account.signingSecretStatus) {
    return account.tokenStatus !== "missing" && account.signingSecretStatus !== "missing";
  }
  return Boolean(account.channelAccessToken?.trim() && account.channelSecret?.trim());
}

export function parseLineAllowFromId(raw: string): string | null {
  const trimmed = raw.trim().replace(/^line:(?:user:)?/i, "");
  if (!/^U[a-f0-9]{32}$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}
