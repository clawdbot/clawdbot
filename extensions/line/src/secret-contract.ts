// Line plugin module implements secret contract behavior.
import { DEFAULT_ACCOUNT_ID, normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import {
  collectConditionalChannelFieldAssignments,
  createChannelSecretTargetRegistryEntries,
  getChannelRecord,
  resolveChannelAccountSurface,
  type ChannelAccountEntry,
  type ChannelAccountSurface,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { channelRootAdmitsDefaultLineAccount } from "./accounts.js";

const LINE_CHANNEL = "line";

const LINE_CREDENTIALS = [
  { field: "channelAccessToken", fileField: "tokenFile" },
  { field: "channelSecret", fileField: "secretFile" },
] as const;

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: LINE_CHANNEL,
  account: LINE_CREDENTIALS.map(({ field }) => field),
  channel: LINE_CREDENTIALS.map(({ field }) => field),
});

/** Whether an account supplies this credential itself, inline or through its own file. */
function accountSuppliesCredential(params: {
  entry: ChannelAccountEntry;
  field: string;
  fileField: string;
}): boolean {
  const { entry, field, fileField } = params;
  return (
    hasConfiguredSecretInput(entry.account[field]) ||
    Boolean(normalizeOptionalString(entry.account[fileField]))
  );
}

/**
 * LINE resolves a default account from channel-level credentials even when the accounts map
 * names only other accounts, so the root credential keeps a consumer the shared surface omits.
 * An id the router cannot read is not that account: it never matches the reader's lookup either.
 */
function resolveLineSecretSurface(params: {
  channel: Record<string, unknown>;
  rootAdmitsDefaultAccount: boolean;
}): ChannelAccountSurface {
  const surface = resolveChannelAccountSurface(params.channel);
  if (
    !surface.hasExplicitAccounts ||
    !params.rootAdmitsDefaultAccount ||
    surface.accounts.some(
      (entry) => normalizeOptionalAccountId(entry.accountId) === DEFAULT_ACCOUNT_ID,
    )
  ) {
    return surface;
  }
  return {
    ...surface,
    accounts: [
      ...surface.accounts,
      { accountId: DEFAULT_ACCOUNT_ID, account: {}, enabled: surface.channelEnabled },
    ],
  };
}

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const channel = getChannelRecord(params.config, LINE_CHANNEL);
  if (!channel) {
    return;
  }
  // The channel-level credentials only have a consumer while the channel admits a default
  // account. Resolving them without one runs an exec or store provider for nobody, so the same
  // answer gates both the accounts-map branch and the one where no accounts map narrows it.
  const rootAdmitsDefaultAccount = channelRootAdmitsDefaultLineAccount({
    config: channel,
    env: params.context.env,
  });
  const surface = resolveLineSecretSurface({ channel, rootAdmitsDefaultAccount });
  for (const { field, fileField } of LINE_CREDENTIALS) {
    collectConditionalChannelFieldAssignments({
      channelKey: LINE_CHANNEL,
      field,
      channel,
      surface,
      defaults: params.defaults,
      context: params.context,
      topLevelActiveWithoutAccounts: rootAdmitsDefaultAccount,
      // Only the default account falls back to channel-level credentials, and only while it
      // supplies neither the inline value nor its own credential file.
      topLevelInheritedAccountActive: (entry) =>
        entry.enabled &&
        normalizeOptionalAccountId(entry.accountId) === DEFAULT_ACCOUNT_ID &&
        !accountSuppliesCredential({ entry, field, fileField }),
      // An account's own credential is read ahead of its credential file, so an enabled
      // account always consumes it.
      accountActive: ({ enabled }) => enabled,
      topInactiveReason: surface.channelEnabled
        ? `no enabled LINE account inherits this channel-level ${field}.`
        : "LINE channel is disabled.",
      accountInactiveReason: "LINE account is disabled.",
    });
  }
}
