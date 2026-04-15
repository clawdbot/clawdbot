import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveSignalAccount } from "./accounts.js";

export function resolveSignalRpcContext(
  opts: { baseUrl?: string; account?: string; accountId?: string },
  accountInfo?: ReturnType<typeof resolveSignalAccount>,
) {
  const hasBaseUrl = Boolean(normalizeOptionalString(opts.baseUrl));
  const hasAccount = Boolean(normalizeOptionalString(opts.account));
  if ((!hasBaseUrl || !hasAccount) && !accountInfo) {
    throw new Error("Signal account config is required when baseUrl or account is missing");
  }
  const resolvedAccount = accountInfo;
  const baseUrl = normalizeOptionalString(opts.baseUrl) ?? resolvedAccount?.baseUrl;
  if (!baseUrl) {
    throw new Error("Signal base URL is required");
  }
  const account =
    normalizeOptionalString(opts.account) ??
    normalizeOptionalString(resolvedAccount?.config.account);
  return { baseUrl, account };
}
