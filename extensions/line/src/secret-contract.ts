// Line plugin module implements secret contract behavior.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
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
  defaults: SecretDefaults | undefined;
}): boolean {
  const { entry, field, fileField, defaults } = params;
  return (
    hasConfiguredSecretInput(entry.account[field], defaults) ||
    Boolean(normalizeOptionalString(entry.account[fileField]))
  );
}

/**
 * LINE resolves a default account from channel-level credentials even when the accounts map
 * names only other accounts, so the root credential keeps a consumer the shared surface omits.
 * The account has to be admitted first: without it the root credential has nothing to serve and
 * resolving it would run an exec or store provider for no consumer.
 */
function resolveLineSecretSurface(params: {
  channel: Record<string, unknown>;
  defaults: SecretDefaults | undefined;
  env: NodeJS.ProcessEnv;
}): ChannelAccountSurface {
  const surface = resolveChannelAccountSurface(params.channel);
  if (
    !surface.hasExplicitAccounts ||
    surface.accounts.some((entry) => normalizeAccountId(entry.accountId) === DEFAULT_ACCOUNT_ID) ||
    !channelRootAdmitsDefaultLineAccount({
      config: params.channel,
      secretDefaults: params.defaults,
      env: params.env,
    })
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
  const surface = resolveLineSecretSurface({
    channel,
    defaults: params.defaults,
    env: params.context.env,
  });
  for (const { field, fileField } of LINE_CREDENTIALS) {
    collectConditionalChannelFieldAssignments({
      channelKey: LINE_CHANNEL,
      field,
      channel,
      surface,
      defaults: params.defaults,
      context: params.context,
      topLevelActiveWithoutAccounts: true,
      // Only the default account falls back to channel-level credentials, and only while it
      // supplies neither the inline value nor its own credential file.
      topLevelInheritedAccountActive: (entry) =>
        entry.enabled &&
        normalizeAccountId(entry.accountId) === DEFAULT_ACCOUNT_ID &&
        !accountSuppliesCredential({ entry, field, fileField, defaults: params.defaults }),
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
