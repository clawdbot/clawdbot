import { normalizeChatChannelId } from "../../../channels/ids.js";
import { listRouteBindings } from "../../../config/bindings.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  formatChannelAccountsDefaultPath,
  formatSetExplicitDefaultInstruction,
  formatSetExplicitDefaultToConfiguredInstruction,
} from "../../../routing/default-account-warnings.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../../../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../../shared/string-coerce.js";
import { asObjectRecord } from "./object.js";

type ChannelMissingDefaultAccountContext = {
  channelKey: string;
  channel: Record<string, unknown>;
  normalizedAccountIds: string[];
};

function normalizeBindingChannelKey(raw?: string | null): string {
  const normalized = normalizeChatChannelId(raw);
  if (normalized) {
    return normalized;
  }
  return normalizeLowercaseStringOrEmpty(raw);
}

function collectChannelsMissingDefaultAccount(
  cfg: OpenClawConfig,
): ChannelMissingDefaultAccountContext[] {
  const channels = asObjectRecord(cfg.channels);
  if (!channels) {
    return [];
  }

  const contexts: ChannelMissingDefaultAccountContext[] = [];
  for (const [channelKey, rawChannel] of Object.entries(channels)) {
    const channel = asObjectRecord(rawChannel);
    if (!channel) {
      continue;
    }
    const accounts = asObjectRecord(channel.accounts);
    if (!accounts) {
      continue;
    }

    const normalizedAccountIds = Array.from(
      new Set(
        Object.keys(accounts)
          .map((accountId) => normalizeAccountId(accountId))
          .filter(Boolean),
      ),
    ).toSorted((a, b) => a.localeCompare(b));
    if (normalizedAccountIds.length === 0 || normalizedAccountIds.includes(DEFAULT_ACCOUNT_ID)) {
      continue;
    }
    contexts.push({ channelKey, channel, normalizedAccountIds });
  }
  return contexts;
}

export function collectMissingDefaultAccountBindingWarnings(cfg: OpenClawConfig): string[] {
  const bindings = listRouteBindings(cfg);
  const warnings: string[] = [];

  for (const { channelKey, normalizedAccountIds } of collectChannelsMissingDefaultAccount(cfg)) {
    const accountIdSet = new Set(normalizedAccountIds);
    const channelPattern = normalizeBindingChannelKey(channelKey);

    let hasWildcardBinding = false;
    const coveredAccountIds = new Set<string>();
    for (const binding of bindings) {
      const bindingRecord = asObjectRecord(binding);
      if (!bindingRecord) {
        continue;
      }
      const match = asObjectRecord(bindingRecord.match);
      if (!match) {
        continue;
      }

      const matchChannel =
        typeof match.channel === "string" ? normalizeBindingChannelKey(match.channel) : "";
      if (!matchChannel || matchChannel !== channelPattern) {
        continue;
      }

      const rawAccountId = normalizeOptionalString(match.accountId) ?? "";
      if (!rawAccountId) {
        continue;
      }
      if (rawAccountId === "*") {
        hasWildcardBinding = true;
        continue;
      }
      const normalizedBindingAccountId = normalizeAccountId(rawAccountId);
      if (accountIdSet.has(normalizedBindingAccountId)) {
        coveredAccountIds.add(normalizedBindingAccountId);
      }
    }

    if (hasWildcardBinding) {
      continue;
    }

    const uncoveredAccountIds = normalizedAccountIds.filter(
      (accountId) => !coveredAccountIds.has(accountId),
    );
    if (uncoveredAccountIds.length === 0) {
      continue;
    }
    if (coveredAccountIds.size > 0) {
      warnings.push(
        `- channels.${channelKey}: accounts.default is missing and account bindings only cover a subset of configured accounts. Uncovered accounts: ${uncoveredAccountIds.join(", ")}. Add bindings[].match.accountId for uncovered accounts (or "*"), or add ${formatChannelAccountsDefaultPath(channelKey)}.`,
      );
      continue;
    }

    warnings.push(
      `- channels.${channelKey}: accounts.default is missing and no valid account-scoped binding exists for configured accounts (${normalizedAccountIds.join(", ")}). Channel-only bindings (no accountId) match only default. Add bindings[].match.accountId for one of these accounts (or "*"), or add ${formatChannelAccountsDefaultPath(channelKey)}.`,
    );
  }

  return warnings;
}

export function collectMissingExplicitDefaultAccountWarnings(cfg: OpenClawConfig): string[] {
  const warnings: string[] = [];
  for (const { channelKey, channel, normalizedAccountIds } of collectChannelsMissingDefaultAccount(
    cfg,
  )) {
    if (normalizedAccountIds.length < 2) {
      continue;
    }

    const preferredDefault = normalizeOptionalAccountId(
      typeof channel.defaultAccount === "string" ? channel.defaultAccount : undefined,
    );
    if (preferredDefault) {
      if (normalizedAccountIds.includes(preferredDefault)) {
        continue;
      }
      warnings.push(
        `- channels.${channelKey}: defaultAccount is set to "${preferredDefault}" but does not match configured accounts (${normalizedAccountIds.join(", ")}). ${formatSetExplicitDefaultToConfiguredInstruction({ channelKey })} to avoid fallback routing.`,
      );
      continue;
    }

    warnings.push(
      `- channels.${channelKey}: multiple accounts are configured but no explicit default is set. ${formatSetExplicitDefaultInstruction(channelKey)} to avoid fallback routing.`,
    );
  }

  return warnings;
}
