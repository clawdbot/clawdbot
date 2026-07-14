/** Basic channel secret runtime helpers for account/root credential collection. */
import { coerceSecretRef } from "../config/types.secrets.js";
import {
  collectSecretInputAssignment,
  hasOwnProperty,
  isChannelAccountEffectivelyEnabled,
  isEnabledFlag,
  type ResolverContext,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";
import type {
  SecretTargetExpected,
  SecretTargetRegistryEntry,
  SecretTargetShape,
} from "./target-registry-types.js";

export type ChannelSecretTargetPathSpec = {
  path: string;
  refPath?: string;
  targetType?: string;
  targetTypeAliases?: string[];
  secretShape?: SecretTargetShape;
  expectedResolvedValue?: SecretTargetExpected;
  accountIdPathSegmentIndex?: number;
};

function buildChannelSecretTargetRegistryEntry(params: {
  channelKey: string;
  scope: "account" | "channel";
  spec: string | ChannelSecretTargetPathSpec;
}): SecretTargetRegistryEntry {
  const spec = typeof params.spec === "string" ? { path: params.spec } : params.spec;
  const scopePrefix =
    params.scope === "account"
      ? `channels.${params.channelKey}.accounts.*`
      : `channels.${params.channelKey}`;
  const pathPattern = `${scopePrefix}.${spec.path}`;
  return {
    id: pathPattern,
    targetType: spec.targetType ?? pathPattern,
    ...(spec.targetTypeAliases ? { targetTypeAliases: spec.targetTypeAliases } : {}),
    configFile: "openclaw.json",
    pathPattern,
    ...(spec.refPath ? { refPathPattern: `${scopePrefix}.${spec.refPath}` } : {}),
    secretShape: spec.secretShape ?? "secret_input",
    expectedResolvedValue: spec.expectedResolvedValue ?? "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    ...(spec.accountIdPathSegmentIndex !== undefined
      ? { accountIdPathSegmentIndex: spec.accountIdPathSegmentIndex }
      : {}),
  };
}

// Builds standard channel/account secret registry rows without repeating fixed metadata.
export function createChannelSecretTargetRegistryEntries(params: {
  channelKey: string;
  account?: readonly (string | ChannelSecretTargetPathSpec)[];
  channel?: readonly (string | ChannelSecretTargetPathSpec)[];
}): SecretTargetRegistryEntry[] {
  return [
    ...(params.account ?? []).map((spec) =>
      buildChannelSecretTargetRegistryEntry({
        channelKey: params.channelKey,
        scope: "account",
        spec,
      }),
    ),
    ...(params.channel ?? []).map((spec) =>
      buildChannelSecretTargetRegistryEntry({
        channelKey: params.channelKey,
        scope: "channel",
        spec,
      }),
    ),
  ];
}

export type ChannelAccountEntry = {
  accountId: string;
  account: Record<string, unknown>;
  enabled: boolean;
};

/** Resolved view of a channel config, including synthetic default-account fallback. */
export type ChannelAccountSurface = {
  hasExplicitAccounts: boolean;
  channelEnabled: boolean;
  accounts: ChannelAccountEntry[];
};

/** Predicate used by channel helpers to decide whether an account-owned secret is active. */
export type ChannelAccountPredicate = (entry: ChannelAccountEntry) => boolean;

/** Reads a channel config block when it exists as an object. */
export function getChannelRecord(
  config: { channels?: Record<string, unknown> },
  channelKey: string,
): Record<string, unknown> | undefined {
  const channels = config.channels;
  if (!isRecord(channels)) {
    return undefined;
  }
  const channel = channels[channelKey];
  return isRecord(channel) ? channel : undefined;
}

/** Reads a channel config and its resolved account surface in one step. */
export function getChannelSurface(
  config: { channels?: Record<string, unknown> },
  channelKey: string,
): { channel: Record<string, unknown>; surface: ChannelAccountSurface } | null {
  const channel = getChannelRecord(config, channelKey);
  if (!channel) {
    return null;
  }
  return {
    channel,
    surface: resolveChannelAccountSurface(channel),
  };
}

/** Resolves explicit channel accounts or creates a default account backed by the channel root. */
export function resolveChannelAccountSurface(
  channel: Record<string, unknown>,
): ChannelAccountSurface {
  const channelEnabled = isEnabledFlag(channel);
  const accounts = channel.accounts;
  if (!isRecord(accounts) || Object.keys(accounts).length === 0) {
    return {
      hasExplicitAccounts: false,
      channelEnabled,
      accounts: [{ accountId: "default", account: channel, enabled: channelEnabled }],
    };
  }
  const accountEntries: ChannelAccountEntry[] = [];
  for (const [accountId, account] of Object.entries(accounts)) {
    if (!isRecord(account)) {
      continue;
    }
    accountEntries.push({
      accountId,
      account,
      enabled: isChannelAccountEffectivelyEnabled(channel, account),
    });
  }
  return {
    hasExplicitAccounts: true,
    channelEnabled,
    accounts: accountEntries,
  };
}

export function isBaseFieldActiveForChannelSurface(
  surface: ChannelAccountSurface,
  rootKey: string,
): boolean {
  if (!surface.channelEnabled) {
    return false;
  }
  if (!surface.hasExplicitAccounts) {
    return true;
  }
  // Top-level channel fields are inherited by enabled accounts that do not override that field.
  return surface.accounts.some(
    ({ account, enabled }) => enabled && !hasOwnProperty(account, rootKey),
  );
}

/** Normalizes optional channel secret strings before deciding whether a value is configured. */
export function normalizeSecretStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Returns true when a channel value contains plaintext or a SecretRef-compatible value. */
export function hasConfiguredSecretInputValue(
  value: unknown,
  defaults: SecretDefaults | undefined,
): boolean {
  return normalizeSecretStringValue(value).length > 0 || coerceSecretRef(value, defaults) !== null;
}

/** Collects a simple channel field from the channel root and explicit account overrides. */
/** Collects root/account channel field SecretRef assignments for one credential path. */
export function collectSimpleChannelFieldAssignments(params: {
  channelKey: string;
  field: string;
  channel: Record<string, unknown>;
  surface: ChannelAccountSurface;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  topInactiveReason: string;
  accountInactiveReason: string;
}): void {
  collectSecretInputAssignment({
    value: params.channel[params.field],
    path: `channels.${params.channelKey}.${params.field}`,
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: isBaseFieldActiveForChannelSurface(params.surface, params.field),
    inactiveReason: params.topInactiveReason,
    apply: (value) => {
      params.channel[params.field] = value;
    },
  });
  if (!params.surface.hasExplicitAccounts) {
    return;
  }
  for (const { accountId, account, enabled } of params.surface.accounts) {
    if (!hasOwnProperty(account, params.field)) {
      continue;
    }
    collectSecretInputAssignment({
      value: account[params.field],
      path: `channels.${params.channelKey}.accounts.${accountId}.${params.field}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: enabled,
      inactiveReason: params.accountInactiveReason,
      apply: (value) => {
        account[params.field] = value;
      },
    });
  }
}

function isConditionalTopLevelFieldActive(params: {
  surface: ChannelAccountSurface;
  activeWithoutAccounts: boolean;
  inheritedAccountActive: ChannelAccountPredicate;
}): boolean {
  if (!params.surface.channelEnabled) {
    return false;
  }
  if (!params.surface.hasExplicitAccounts) {
    return params.activeWithoutAccounts;
  }
  return params.surface.accounts.some(params.inheritedAccountActive);
}

/** Collects a channel field whose active state depends on caller-provided account predicates. */
export function collectConditionalChannelFieldAssignments(params: {
  channelKey: string;
  field: string;
  channel: Record<string, unknown>;
  surface: ChannelAccountSurface;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  topLevelActiveWithoutAccounts: boolean;
  topLevelInheritedAccountActive: ChannelAccountPredicate;
  accountActive: ChannelAccountPredicate;
  topInactiveReason: string;
  accountInactiveReason: string | ((entry: ChannelAccountEntry) => string);
}): void {
  collectSecretInputAssignment({
    value: params.channel[params.field],
    path: `channels.${params.channelKey}.${params.field}`,
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: isConditionalTopLevelFieldActive({
      surface: params.surface,
      activeWithoutAccounts: params.topLevelActiveWithoutAccounts,
      inheritedAccountActive: params.topLevelInheritedAccountActive,
    }),
    inactiveReason: params.topInactiveReason,
    apply: (value) => {
      params.channel[params.field] = value;
    },
  });
  if (!params.surface.hasExplicitAccounts) {
    return;
  }
  for (const entry of params.surface.accounts) {
    if (!hasOwnProperty(entry.account, params.field)) {
      continue;
    }
    collectSecretInputAssignment({
      value: entry.account[params.field],
      path: `channels.${params.channelKey}.accounts.${entry.accountId}.${params.field}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: params.accountActive(entry),
      inactiveReason:
        typeof params.accountInactiveReason === "function"
          ? params.accountInactiveReason(entry)
          : params.accountInactiveReason,
      apply: (value) => {
        entry.account[params.field] = value;
      },
    });
  }
}

/** Collects a nested channel field from root and account-specific nested config blocks. */
export function collectNestedChannelFieldAssignments(params: {
  channelKey: string;
  nestedKey: string;
  field: string;
  channel: Record<string, unknown>;
  surface: ChannelAccountSurface;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  topLevelActive: boolean;
  topInactiveReason: string;
  accountActive: ChannelAccountPredicate;
  accountInactiveReason: string | ((entry: ChannelAccountEntry) => string);
}): void {
  const topLevelNested = params.channel[params.nestedKey];
  if (isRecord(topLevelNested)) {
    collectSecretInputAssignment({
      value: topLevelNested[params.field],
      path: `channels.${params.channelKey}.${params.nestedKey}.${params.field}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: params.topLevelActive,
      inactiveReason: params.topInactiveReason,
      apply: (value) => {
        topLevelNested[params.field] = value;
      },
    });
  }
  if (!params.surface.hasExplicitAccounts) {
    return;
  }
  for (const entry of params.surface.accounts) {
    const nested = entry.account[params.nestedKey];
    if (!isRecord(nested)) {
      continue;
    }
    collectSecretInputAssignment({
      value: nested[params.field],
      path: `channels.${params.channelKey}.accounts.${entry.accountId}.${params.nestedKey}.${params.field}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: params.accountActive(entry),
      inactiveReason:
        typeof params.accountInactiveReason === "function"
          ? params.accountInactiveReason(entry)
          : params.accountInactiveReason,
      apply: (value) => {
        nested[params.field] = value;
      },
    });
  }
}
