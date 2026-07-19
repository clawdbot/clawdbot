// Whatsapp plugin module implements doctor contract behavior.
import { isDeepStrictEqual } from "node:util";
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { mergeDeep } from "openclaw/plugin-sdk/plugin-config-runtime";
import { asObjectRecord, defineChannelAliasMigration } from "openclaw/plugin-sdk/runtime-doctor";
import { normalizeCompatibilityConfig as normalizeAckReactionConfig } from "./doctor.js";

// WhatsApp's nested streaming schema is delivery-only ({chunkMode, block});
// it has no preview mode, so only the delivery flat aliases are legal legacy
// input. Seeding is handled below instead of via accountStreamingReplacesRoot
// because WhatsApp resolution layers accounts.default shared config between
// the channel root and named accounts (account-config.ts), so a materialized
// named-account object must inherit default-account settings over root ones.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "whatsapp",
  streaming: { defaultMode: "partial", deliveryOnly: true },
});

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] =
  streamingAliasMigration.legacyConfigRules;

// The runtime merge replaces `streaming` wholesale per layer (named account >
// accounts.default > root), while the retired flat keys resolved per key
// across those layers. Account objects that migration materializes must carry
// the settings the account previously inherited, or `doctor --fix` silently
// changes effective delivery behavior for that account.
function materializeMigratedAccountStreaming(params: {
  cfg: OpenClawConfig;
  accountsBefore: Record<string, unknown> | null;
  changes: string[];
}): OpenClawConfig {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const entry = asObjectRecord(channels?.whatsapp);
  const accounts = asObjectRecord(entry?.accounts);
  if (!entry || !accounts) {
    return params.cfg;
  }
  const rootStreaming = asObjectRecord(entry.streaming);
  // Account lookup treats keys case-insensitively (resolveAccountEntry), so
  // `accounts.Default` is the default account too.
  const defaultKey = Object.hasOwn(accounts, "default")
    ? "default"
    : Object.keys(accounts).find((key) => key.trim().toLowerCase() === "default");

  let accountsChanged = false;
  const nextAccounts = { ...accounts };
  // Seed the default account first: its final object is the inheritance
  // source for named accounts (default replaces root wholesale when set).
  const accountIds = Object.keys(accounts).toSorted((left, right) =>
    left === defaultKey ? -1 : right === defaultKey ? 1 : left.localeCompare(right),
  );
  for (const accountId of accountIds) {
    const accountBefore = asObjectRecord(params.accountsBefore?.[accountId]);
    if (accountBefore?.streaming !== undefined) {
      continue;
    }
    const account = asObjectRecord(nextAccounts[accountId]);
    const created = asObjectRecord(account?.streaming);
    if (!account || !created) {
      continue;
    }
    const defaultStreaming = defaultKey
      ? asObjectRecord(asObjectRecord(nextAccounts[defaultKey])?.streaming)
      : null;
    const inheritedSource =
      accountId === defaultKey ? rootStreaming : (defaultStreaming ?? rootStreaming);
    if (!inheritedSource) {
      continue;
    }
    const materialized = asObjectRecord(mergeDeep(inheritedSource, created));
    if (!materialized || isDeepStrictEqual(materialized, created)) {
      continue;
    }
    nextAccounts[accountId] = { ...account, streaming: materialized };
    accountsChanged = true;
    const sourcePath =
      accountId !== defaultKey && defaultKey && defaultStreaming
        ? `channels.whatsapp.accounts.${defaultKey}.streaming`
        : "channels.whatsapp.streaming";
    params.changes.push(
      `Copied ${sourcePath} into channels.whatsapp.accounts.${accountId}.streaming to keep inherited settings while migrating flat streaming keys.`,
    );
  }
  if (!accountsChanged) {
    return params.cfg;
  }
  return {
    ...params.cfg,
    channels: {
      ...channels,
      whatsapp: { ...entry, accounts: nextAccounts },
    },
  } as OpenClawConfig;
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const ackReaction = normalizeAckReactionConfig({ cfg });
  const accountsBefore = asObjectRecord(
    asObjectRecord((ackReaction.config.channels as Record<string, unknown> | undefined)?.whatsapp)
      ?.accounts,
  );
  const aliases = streamingAliasMigration.normalizeChannelConfig({
    cfg: ackReaction.config,
    changes: ackReaction.changes,
  });
  return {
    config: materializeMigratedAccountStreaming({
      cfg: aliases.config,
      accountsBefore,
      changes: aliases.changes,
    }),
    changes: aliases.changes,
  };
}
