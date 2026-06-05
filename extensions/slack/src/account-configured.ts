// Slack helper module supports account configured behavior.
import { hasConfiguredAccountValue } from "openclaw/plugin-sdk/account-resolution";
import type { ResolvedSlackAccount } from "./accounts.js";

export function isSlackPluginAccountConfigured(account: ResolvedSlackAccount): boolean {
  const mode = account.config.mode ?? "socket";
  const hasBotToken = Boolean(account.botToken?.trim());
  if (!hasBotToken) {
    return false;
  }
  if (mode === "http") {
    return hasConfiguredAccountValue(account.config.signingSecret);
  }
  return Boolean(account.appToken?.trim());
}
