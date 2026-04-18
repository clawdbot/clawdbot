export { resolveMergedAccountConfig } from "../channels/plugins/account-helpers.js";
export { resolveNormalizedAccountEntry } from "../routing/account-lookup.js";

/** List normalized configured account ids from a raw channel account record map. */
export function listConfiguredAccountIds(params: {
  accounts: Record<string, unknown> | undefined;
  normalizeAccountId: (accountId: string) => string;
}): string[] {
  if (!params.accounts) {
    return [];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(params.accounts)) {
    if (!key) {
      continue;
    }
    ids.add(params.normalizeAccountId(key));
  }
  return [...ids];
}
