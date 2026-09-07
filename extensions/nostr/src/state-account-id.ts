// Nostr state stores keep legacy account key bytes; do not use the newer SDK normalizer here.
export function normalizeNostrStateAccountId(accountId?: string): string {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}
