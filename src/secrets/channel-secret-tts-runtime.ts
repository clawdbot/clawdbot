/** Runtime adapter for channel text-to-speech secret contracts. */
import type {
  ChannelAccountPredicate,
  ChannelAccountSurface,
} from "./channel-secret-basic-runtime.js";
import { collectTtsApiKeyAssignments } from "./runtime-config-collectors-tts.js";
import type { ResolverContext, SecretDefaults } from "./runtime-shared.js";
import { isRecord } from "./shared.js";

type NestedProviderOwnerId =
  | string
  | ((entry: { accountId: string; providerId: string }) => string);

/** Collects nested provider SecretRefs from channel root and account blocks. */
export function collectNestedChannelTtsAssignments(params: {
  /** Channel config key used in runtime warning/assignment paths. */
  channelKey: string;
  /** Nested channel config field that owns the provider block, such as `outbound` or `voice`. */
  nestedKey: string;
  /** Config block below the nested channel field that owns `providers`. Defaults to `tts`. */
  providerBlockKey?: string;
  /** Capability owner used for degraded-secret attribution. Defaults to `tts`. */
  ownerId?: NestedProviderOwnerId;
  channel: Record<string, unknown>;
  surface: ChannelAccountSurface;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  /** Whether the top-level nested provider block can affect runtime behavior. */
  topLevelActive: boolean;
  topInactiveReason: string;
  /** Per-account activity predicate for account-specific nested provider blocks. */
  accountActive: ChannelAccountPredicate;
  accountInactiveReason:
    | string
    | ((entry: {
        accountId: string;
        account: Record<string, unknown>;
        enabled: boolean;
      }) => string);
}): void {
  const providerBlockKey = params.providerBlockKey ?? "tts";
  const ownerId = params.ownerId;
  const resolveOwnerId = (accountId: string) =>
    typeof ownerId === "function"
      ? (providerId: string) => ownerId({ accountId, providerId })
      : (ownerId ?? "tts");
  const topLevelNested = params.channel[params.nestedKey];
  const topLevelProviderBlock =
    isRecord(topLevelNested) && isRecord(topLevelNested[providerBlockKey])
      ? topLevelNested[providerBlockKey]
      : undefined;
  if (topLevelProviderBlock) {
    const collectTopLevel = (accountId: string, active: boolean) =>
      collectTtsApiKeyAssignments({
        tts: topLevelProviderBlock,
        pathPrefix: `channels.${params.channelKey}.${params.nestedKey}.${providerBlockKey}`,
        ownerId: resolveOwnerId(accountId),
        defaults: params.defaults,
        context: params.context,
        active,
        inactiveReason: params.topInactiveReason,
      });
    if (typeof params.ownerId !== "function") {
      collectTopLevel("default", params.topLevelActive);
    } else {
      const inheritingAccounts = params.surface.hasExplicitAccounts
        ? params.surface.accounts.filter(
            ({ account, enabled }) =>
              params.topLevelActive && enabled && !Object.hasOwn(account, params.nestedKey),
          )
        : params.topLevelActive
          ? [{ accountId: "default" }]
          : [];
      if (inheritingAccounts.length === 0) {
        collectTopLevel("default", false);
      } else {
        for (const { accountId } of inheritingAccounts) {
          collectTopLevel(accountId, true);
        }
      }
    }
  }
  if (!params.surface.hasExplicitAccounts) {
    return;
  }
  for (const entry of params.surface.accounts) {
    const nested = entry.account[params.nestedKey];
    const providerBlock =
      isRecord(nested) && isRecord(nested[providerBlockKey]) ? nested[providerBlockKey] : undefined;
    if (!providerBlock) {
      continue;
    }
    collectTtsApiKeyAssignments({
      tts: providerBlock,
      pathPrefix: `channels.${params.channelKey}.accounts.${entry.accountId}.${params.nestedKey}.${providerBlockKey}`,
      ownerId: resolveOwnerId(entry.accountId),
      defaults: params.defaults,
      context: params.context,
      active: params.accountActive(entry),
      inactiveReason:
        typeof params.accountInactiveReason === "function"
          ? params.accountInactiveReason(entry)
          : params.accountInactiveReason,
    });
  }
}
