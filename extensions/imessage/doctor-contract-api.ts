// Imessage API module exposes the plugin public contract.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { defineChannelAliasMigration } from "openclaw/plugin-sdk/runtime-doctor";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

// Disabled `channels.imessage.catchup` blocks are retired. Enabled blocks stay
// as a compatibility contract: older configs that opted into replay still get
// downtime recovery, while new/default installs use the always-on recovery
// cursor plus stale-backlog fence.
function isEnabledCatchup(value: unknown): boolean {
  return isRecord(value) && value.enabled === true;
}

function imessageEntryHasRetiredCatchup(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  if (Object.hasOwn(entry, "catchup") && !isEnabledCatchup(entry.catchup)) {
    return true;
  }
  const accounts = entry.accounts;
  if (!isRecord(accounts)) {
    return false;
  }
  return Object.values(accounts).some(
    (account) =>
      isRecord(account) && Object.hasOwn(account, "catchup") && !isEnabledCatchup(account.catchup),
  );
}

// iMessage's nested streaming schema is delivery-only ({chunkMode, block}); it
// has no preview mode, so only the delivery flat aliases are legal legacy input.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "imessage",
  streaming: { defaultMode: "partial", deliveryOnly: true },
});

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "imessage"],
    message:
      "disabled channels.imessage.catchup config is retired; iMessage now recovers via always-on inbound dedupe and a stale-backlog age fence. " +
      'Run "openclaw doctor --fix" to remove disabled catchup blocks.',
    match: (value) => imessageEntryHasRetiredCatchup(value),
  },
  ...streamingAliasMigration.legacyConfigRules,
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const imessage = channels?.imessage;
  if (!isRecord(imessage)) {
    return { config: cfg, changes: [] };
  }
  const changes: string[] = [];
  let nextImessage: Record<string, unknown> = imessage;
  if (imessageEntryHasRetiredCatchup(nextImessage)) {
    nextImessage = { ...nextImessage };
    if (Object.hasOwn(nextImessage, "catchup") && !isEnabledCatchup(nextImessage.catchup)) {
      delete nextImessage.catchup;
      changes.push("Removed disabled retired channels.imessage.catchup.");
    }
    if (isRecord(nextImessage.accounts)) {
      let accountsChanged = false;
      const nextAccounts: Record<string, unknown> = { ...nextImessage.accounts };
      for (const [id, account] of Object.entries(nextImessage.accounts)) {
        if (
          isRecord(account) &&
          Object.hasOwn(account, "catchup") &&
          !isEnabledCatchup(account.catchup)
        ) {
          const nextAccount = { ...account };
          delete nextAccount.catchup;
          nextAccounts[id] = nextAccount;
          accountsChanged = true;
          changes.push(`Removed disabled retired channels.imessage.accounts.${id}.catchup.`);
        }
      }
      if (accountsChanged) {
        nextImessage.accounts = nextAccounts;
      }
    }
  }

  const aliases = streamingAliasMigration.normalizeChannelConfig({
    cfg:
      nextImessage === imessage
        ? cfg
        : ({ ...cfg, channels: { ...channels, imessage: nextImessage } } as OpenClawConfig),
    changes,
  });
  if (changes.length === 0) {
    return { config: cfg, changes: [] };
  }
  return { config: aliases.config, changes };
}
