import { resolveSignalAccount } from "./accounts.js";

export function resolveSignalRpcContext(
  opts: { baseUrl?: string; account?: string; accountId?: string },
  accountInfo?: ReturnType<typeof resolveSignalAccount>,
) {
  const baseUrlOverride = opts.baseUrl?.trim();
  const accountOverride = opts.account?.trim();
  if ((!baseUrlOverride || !accountOverride) && !accountInfo) {
    throw new Error("Signal account config is required when baseUrl or account is missing");
  }
  const baseUrl = baseUrlOverride || accountInfo?.baseUrl;
  if (!baseUrl) {
    throw new Error("Signal base URL is required");
  }
  const account = accountOverride || accountInfo?.config.account?.trim() || undefined;
  return { baseUrl, account };
}
