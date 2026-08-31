// Slack helper module supports account configured behavior.
import { hasConfiguredAccountValue } from "openclaw/plugin-sdk/account-resolution";
import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";

type SlackCredentialAccount = {
  identity: "bot" | "user";
  botToken?: string;
  appToken?: string;
  userToken?: string;
  config: SlackAccountConfig;
};

export function hasSlackAccountCredentials(params: {
  config: SlackAccountConfig;
  identityTokenConfigured: boolean;
  appTokenConfigured: boolean;
}): boolean {
  if (!params.identityTokenConfigured) {
    return false;
  }
  const mode = params.config.mode ?? "socket";
  if (mode === "http") {
    return hasConfiguredAccountValue(params.config.signingSecret);
  }
  if (mode === "relay") {
    const relay = params.config.relay;
    return (
      hasConfiguredAccountValue(relay?.url) &&
      hasConfiguredAccountValue(relay?.authToken) &&
      hasConfiguredAccountValue(relay?.gatewayId)
    );
  }
  return params.appTokenConfigured;
}

export function isSlackPluginAccountConfigured(account: SlackCredentialAccount): boolean {
  const identityToken = account.identity === "user" ? account.userToken : account.botToken;
  return hasSlackAccountCredentials({
    config: account.config,
    identityTokenConfigured: Boolean(identityToken?.trim()),
    appTokenConfigured: Boolean(account.appToken?.trim()),
  });
}

export function isSlackSetupAccountConfigured(account: SlackCredentialAccount): boolean {
  if (account.config.mode === "relay") {
    return isSlackPluginAccountConfigured(account);
  }
  const identityToken = account.identity === "user" ? account.userToken : account.botToken;
  const configuredIdentityToken =
    account.identity === "user" ? account.config.userToken : account.config.botToken;
  return hasSlackAccountCredentials({
    config: account.config,
    identityTokenConfigured:
      Boolean(identityToken?.trim()) || hasConfiguredSecretInput(configuredIdentityToken),
    appTokenConfigured:
      Boolean(account.appToken?.trim()) || hasConfiguredSecretInput(account.config.appToken),
  });
}
