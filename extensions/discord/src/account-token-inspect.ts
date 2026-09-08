// Discord plugin module implements account token inspect behavior.
import {
  hasConfiguredSecretInput,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import type { DiscordCredentialStatus } from "./token.js";

type InspectedDiscordConfiguredToken = {
  token: string;
  tokenSource: "config";
  tokenStatus: Exclude<DiscordCredentialStatus, "missing">;
};

type DiscordAccountTokenState = {
  token: string;
  tokenSource: "env" | "config" | "none";
  tokenStatus: DiscordCredentialStatus;
  configured: boolean;
};

function inspectDiscordConfiguredToken(value: unknown): InspectedDiscordConfiguredToken | null {
  const normalized = normalizeSecretInputString(value);
  if (normalized) {
    return {
      token: normalized.replace(/^Bot\s+/i, ""),
      tokenSource: "config",
      tokenStatus: "available",
    };
  }
  if (hasConfiguredSecretInput(value)) {
    return {
      token: "",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
    };
  }
  return null;
}

export function inspectDiscordAccountTokenState<TBase extends object, TConfig>(params: {
  base: TBase;
  config: TConfig;
  accountToken: unknown;
  hasAccountToken: boolean;
  channelToken: unknown;
  resolveFallbackToken: () => { token: string; source: "env" | "config" | "none" };
}): TBase & DiscordAccountTokenState & { config: TConfig } {
  const accountToken = inspectDiscordConfiguredToken(params.accountToken);
  if (accountToken) {
    return { ...params.base, ...accountToken, configured: true, config: params.config };
  }
  if (params.hasAccountToken) {
    return {
      ...params.base,
      token: "",
      tokenSource: "none",
      tokenStatus: "missing",
      configured: false,
      config: params.config,
    };
  }
  const channelToken = inspectDiscordConfiguredToken(params.channelToken);
  if (channelToken) {
    return { ...params.base, ...channelToken, configured: true, config: params.config };
  }
  const fallback = params.resolveFallbackToken();
  if (fallback.token) {
    return {
      ...params.base,
      token: fallback.token,
      tokenSource: fallback.source,
      tokenStatus: "available",
      configured: true,
      config: params.config,
    };
  }
  return {
    ...params.base,
    token: "",
    tokenSource: "none",
    tokenStatus: "missing",
    configured: false,
    config: params.config,
  };
}

type DiscordTokenOwnerAccount = {
  accountId: string;
  enabled: boolean;
  token: string;
  tokenSource: "env" | "config" | "none";
};

/** Runtime and inspection keep the first enabled owner, preferring config over env tokens. */
export function resolveDiscordAccountAvailability(params: {
  account: DiscordTokenOwnerAccount;
  resolveAccounts: () => Iterable<DiscordTokenOwnerAccount>;
}): { enabled: boolean; stateReason?: string } {
  if (!params.account.enabled) {
    return { enabled: false, stateReason: "disabled" };
  }
  const token = params.account.token.trim();
  let owner: { accountId: string; priority: number } | undefined;
  if (token) {
    for (const account of params.resolveAccounts()) {
      if (!account.enabled || account.token.trim() !== token) {
        continue;
      }
      const priority = account.tokenSource === "config" ? 2 : account.tokenSource === "env" ? 1 : 0;
      if (!owner || priority > owner.priority) {
        owner = { accountId: account.accountId, priority };
      }
    }
  }
  const duplicateOwner =
    owner && owner.accountId !== params.account.accountId ? owner.accountId : undefined;
  return {
    enabled: !duplicateOwner,
    stateReason: duplicateOwner
      ? `duplicate bot token; using account "${duplicateOwner}"`
      : undefined,
  };
}
