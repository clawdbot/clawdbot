// Slack helper module supports account configured behavior.
import { hasConfiguredAccountValue } from "openclaw/plugin-sdk/account-resolution";
import type { ResolvedSlackAccount } from "./accounts.js";

export function isSlackPluginAccountConfigured(account: ResolvedSlackAccount): boolean {
  const mode = account.config.mode ?? "socket";
  const hasIdentityToken =
    account.identity === "user"
      ? Boolean(account.userToken?.trim())
      : Boolean(account.botToken?.trim());
  if (!hasIdentityToken) {
    return false;
  }
  if (mode === "http") {
    return hasConfiguredAccountValue(account.config.signingSecret);
  }
  if (mode === "relay") {
    const relay = account.config.relay;
    return (
      hasConfiguredAccountValue(relay?.url) &&
      hasConfiguredAccountValue(relay?.authToken) &&
      hasConfiguredAccountValue(relay?.gatewayId)
    );
  }
  return Boolean(account.appToken?.trim());
}
