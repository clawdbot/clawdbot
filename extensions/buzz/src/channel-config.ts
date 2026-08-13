import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  formatTrimmedAllowFromEntries,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  listBuzzAccountIds,
  resolveBuzzAccount,
  resolveDefaultBuzzAccountId,
  type ResolvedBuzzAccount,
} from "./types.js";

export const buzzConfigAdapter = {
  ...createScopedChannelConfigAdapter<ResolvedBuzzAccount>({
    sectionKey: "buzz",
    listAccountIds: listBuzzAccountIds,
    resolveAccount: adaptScopedAccountAccessor(resolveBuzzAccount),
    defaultAccountId: resolveDefaultBuzzAccountId,
    clearBaseFields: ["name", "relayUrl", "privateKey", "authTag", "groups", "defaultTo"],
    resolveAllowFrom: (account) => account.config.groupAllowFrom,
    formatAllowFrom: formatTrimmedAllowFromEntries,
    resolveDefaultTo: (account) => account.config.defaultTo,
  }),
  isConfigured: (account: ResolvedBuzzAccount) => account.configured,
  describeAccount: (account: ResolvedBuzzAccount) =>
    describeAccountSnapshot({
      account,
      configured: account.configured,
      extra: { baseUrl: account.relayUrl, publicKey: account.publicKey },
    }),
};
