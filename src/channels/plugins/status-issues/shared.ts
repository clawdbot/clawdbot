/**
 * Channel status issue helper utilities.
 *
 * Formats status metadata and finds enabled/configured account ids for diagnostics.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isRecord } from "../../../utils.js";
import type { ChannelAccountSnapshot, ChannelStatusIssue } from "../types.public.js";
export { isRecord };

/**
 * Formats optional match metadata for status issue messages.
 */
export function formatMatchMetadata(params: {
  matchKey?: unknown;
  matchSource?: unknown;
}): string | undefined {
  const matchKey =
    typeof params.matchKey === "string"
      ? params.matchKey
      : typeof params.matchKey === "number"
        ? String(params.matchKey)
        : undefined;
  const matchSource = normalizeOptionalString(params.matchSource);
  const parts = [
    matchKey ? `matchKey=${matchKey}` : null,
    matchSource ? `matchSource=${matchSource}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Appends formatted match metadata to a status issue message.
 */
export function appendMatchMetadata(
  message: string,
  params: { matchKey?: unknown; matchSource?: unknown },
): string {
  const meta = formatMatchMetadata(params);
  return meta ? `${message} (${meta})` : message;
}

/**
 * Resolves the account id for enabled, configured account snapshots.
 */
export function resolveEnabledConfiguredAccountId(account: {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
}): string | null {
  const accountId = normalizeOptionalString(account.accountId) ?? "default";
  const enabled = account.enabled !== false;
  const configured = account.configured === true;
  return enabled && configured ? accountId : null;
}

/**
 * Collects status issues only for enabled account snapshots.
 */
export function collectIssuesForEnabledAccounts<
  T extends { accountId?: unknown; enabled?: unknown },
>(params: {
  accounts: ChannelAccountSnapshot[];
  readAccount: (value: ChannelAccountSnapshot) => T | null;
  collectIssues: (params: { account: T; accountId: string; issues: ChannelStatusIssue[] }) => void;
}): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const entry of params.accounts) {
    const account = params.readAccount(entry);
    // Disabled accounts should not produce missing credential/runtime issues in
    // status output; they are intentionally inactive.
    if (!account || account.enabled === false) {
      continue;
    }
    const accountId = normalizeOptionalString(account.accountId) ?? "default";
    params.collectIssues({ account, accountId, issues });
  }
  return issues;
}
