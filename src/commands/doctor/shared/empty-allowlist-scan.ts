// Doctor scanner for empty allowlist policies across configured channels and accounts.
import type { ChannelDoctorEmptyAllowlistAccountContext } from "../../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getDoctorChannelCapabilities,
  resolveDoctorChannelAccountIds,
} from "../channel-capabilities.js";
import type { DoctorAccountRecord, DoctorAllowFromList } from "../types.js";
import { hasAllowFromEntries } from "./allowlist.js";
import { collectEmptyAllowlistPolicyWarningsForAccount } from "./empty-allowlist-policy.js";
import { asObjectRecord } from "./object.js";

type ScanEmptyAllowlistPolicyWarningsParams = {
  doctorFixCommand: string;
  extraWarningsForAccount?: (params: ChannelDoctorEmptyAllowlistAccountContext) => string[];
  shouldSkipDefaultEmptyGroupAllowlistWarning?: (
    params: ChannelDoctorEmptyAllowlistAccountContext,
  ) => boolean;
};

function isDisabledRecord(value: unknown): boolean {
  return (
    Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
    (value as { enabled?: unknown }).enabled === false
  );
}

/** Scan all configured channels/accounts for empty allowlist policy warnings. */
export function scanEmptyAllowlistPolicyWarnings(
  cfg: OpenClawConfig,
  params: ScanEmptyAllowlistPolicyWarningsParams,
): string[] {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object") {
    return [];
  }

  const warnings: string[] = [];

  const checkAccount = (
    account: DoctorAccountRecord,
    prefix: string,
    channelName: string,
    parent?: DoctorAccountRecord,
    options: { suppressGroupAllowlistWarning?: boolean } = {},
  ) => {
    const accountDm = asObjectRecord(account.dm);
    const parentDm = asObjectRecord(parent?.dm);
    const dmPolicy =
      (account.dmPolicy as string | undefined) ??
      (accountDm?.policy as string | undefined) ??
      (parent?.dmPolicy as string | undefined) ??
      (parentDm?.policy as string | undefined) ??
      undefined;
    const effectiveAllowFrom =
      (account.allowFrom as DoctorAllowFromList | undefined) ??
      (parent?.allowFrom as DoctorAllowFromList | undefined) ??
      (accountDm?.allowFrom as DoctorAllowFromList | undefined) ??
      (parentDm?.allowFrom as DoctorAllowFromList | undefined) ??
      undefined;

    warnings.push(
      ...collectEmptyAllowlistPolicyWarningsForAccount({
        account,
        channelName,
        cfg,
        doctorFixCommand: params.doctorFixCommand,
        parent,
        prefix,
        shouldSkipDefaultEmptyGroupAllowlistWarning: (context) =>
          options.suppressGroupAllowlistWarning ||
          Boolean(params.shouldSkipDefaultEmptyGroupAllowlistWarning?.(context)),
      }),
    );
    if (params.extraWarningsForAccount) {
      warnings.push(
        ...params.extraWarningsForAccount({
          account,
          channelName,
          dmPolicy,
          effectiveAllowFrom,
          parent,
          prefix,
        }),
      );
    }
  };

  for (const [channelName, channelConfig] of Object.entries(
    channels as Record<string, DoctorAccountRecord>,
  )) {
    if (!channelConfig || typeof channelConfig !== "object") {
      continue;
    }
    if (isDisabledRecord(channelConfig)) {
      continue;
    }
    const accounts = asObjectRecord(channelConfig.accounts);
    const activeAccounts = accounts
      ? Object.values(accounts).filter((account): account is DoctorAccountRecord =>
          Boolean(account && typeof account === "object" && !isDisabledRecord(account)),
        )
      : [];
    const accountIds = resolveDoctorChannelAccountIds(
      channelName,
      cfg,
      Object.keys(accounts ?? {}),
    );
    const configuredAccountIds = new Set(accountIds?.configured);
    const hasImplicitActiveAccount =
      accountIds === undefined ||
      accountIds.runtime.some((accountId) => !configuredAccountIds.has(accountId));
    const suppressParentGroupAllowlistWarning =
      activeAccounts.length > 0 &&
      !hasImplicitActiveAccount &&
      channelConfig.groupPolicy === "allowlist" &&
      activeAccounts.every((account) => {
        const rawGroupAllowFrom =
          (account.groupAllowFrom as DoctorAllowFromList | undefined) ??
          (channelConfig.groupAllowFrom as DoctorAllowFromList | undefined);
        const groupAllowFrom = hasAllowFromEntries(rawGroupAllowFrom)
          ? rawGroupAllowFrom
          : undefined;
        if (hasAllowFromEntries(groupAllowFrom)) {
          return true;
        }
        if (!getDoctorChannelCapabilities(channelName).groupAllowFromFallbackToAllowFrom) {
          return false;
        }
        const accountDm = asObjectRecord(account.dm);
        const parentDm = asObjectRecord(channelConfig.dm);
        const effectiveAllowFrom =
          (account.allowFrom as DoctorAllowFromList | undefined) ??
          (channelConfig.allowFrom as DoctorAllowFromList | undefined) ??
          (accountDm?.allowFrom as DoctorAllowFromList | undefined) ??
          (parentDm?.allowFrom as DoctorAllowFromList | undefined) ??
          undefined;
        return hasAllowFromEntries(effectiveAllowFrom);
      });

    checkAccount(channelConfig, `channels.${channelName}`, channelName, undefined, {
      suppressGroupAllowlistWarning: suppressParentGroupAllowlistWarning,
    });

    if (!accounts) {
      continue;
    }
    for (const [accountId, account] of Object.entries(accounts)) {
      if (!account || typeof account !== "object") {
        continue;
      }
      if (isDisabledRecord(account)) {
        continue;
      }
      checkAccount(
        account as DoctorAccountRecord,
        `channels.${channelName}.accounts.${accountId}`,
        channelName,
        channelConfig,
      );
    }
  }

  return warnings;
}
