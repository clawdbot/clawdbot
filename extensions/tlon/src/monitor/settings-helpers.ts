import type { PendingApproval, TlonSettingsStore } from "../settings.js";
import { normalizeShip } from "../targets.js";
import type { TlonResolvedAccount } from "../types.js";

export type TlonMonitorSettingsState = {
  effectiveDmAllowlist: string[];
  effectiveShowModelSig: boolean;
  effectiveAutoAcceptDmInvites: boolean;
  effectiveAutoAcceptGroupInvites: boolean;
  effectiveGroupInviteAllowlist: string[];
  effectiveAutoDiscoverChannels: boolean;
  effectiveOwnerShip: string | null;
  pendingApprovals: PendingApproval[];
  currentSettings: TlonSettingsStore;
};

export function buildTlonSettingsMigrations(
  account: TlonResolvedAccount,
  currentSettings: TlonSettingsStore,
): Array<{ key: string; fileValue: unknown; settingsValue: unknown }> {
  return [
    {
      key: "dmAllowlist",
      fileValue: account.dmAllowlist,
      settingsValue: currentSettings.dmAllowlist,
    },
    {
      key: "groupInviteAllowlist",
      fileValue: account.groupInviteAllowlist,
      settingsValue: currentSettings.groupInviteAllowlist,
    },
    {
      key: "groupChannels",
      fileValue: account.groupChannels,
      settingsValue: currentSettings.groupChannels,
    },
    {
      key: "defaultAuthorizedShips",
      fileValue: account.defaultAuthorizedShips,
      settingsValue: currentSettings.defaultAuthorizedShips,
    },
    {
      key: "autoDiscoverChannels",
      fileValue: account.autoDiscoverChannels,
      settingsValue: currentSettings.autoDiscoverChannels,
    },
    {
      key: "autoAcceptDmInvites",
      fileValue: account.autoAcceptDmInvites,
      settingsValue: currentSettings.autoAcceptDmInvites,
    },
    {
      key: "autoAcceptGroupInvites",
      fileValue: account.autoAcceptGroupInvites,
      settingsValue: currentSettings.autoAcceptGroupInvites,
    },
    {
      key: "showModelSig",
      fileValue: account.showModelSignature,
      settingsValue: currentSettings.showModelSig,
    },
  ];
}

export function shouldMigrateTlonSetting(fileValue: unknown, settingsValue: unknown): boolean {
  const hasFileValue = Array.isArray(fileValue) ? fileValue.length > 0 : fileValue != null;
  const hasSettingsValue = settingsValue != null;
  return hasFileValue && !hasSettingsValue;
}

export function applyTlonSettingsOverrides(params: {
  account: TlonResolvedAccount;
  currentSettings: TlonSettingsStore;
  log?: (message: string) => void;
}): TlonMonitorSettingsState {
  let effectiveDmAllowlist = params.account.dmAllowlist;
  let effectiveShowModelSig = params.account.showModelSignature ?? false;
  let effectiveAutoAcceptDmInvites = params.account.autoAcceptDmInvites ?? false;
  let effectiveAutoAcceptGroupInvites = params.account.autoAcceptGroupInvites ?? false;
  let effectiveGroupInviteAllowlist = params.account.groupInviteAllowlist;
  let effectiveAutoDiscoverChannels = params.account.autoDiscoverChannels ?? false;
  let effectiveOwnerShip = params.account.ownerShip
    ? normalizeShip(params.account.ownerShip)
    : null;
  let pendingApprovals: PendingApproval[] = [];

  if (params.currentSettings.defaultAuthorizedShips?.length) {
    params.log?.(
      `[tlon] Using defaultAuthorizedShips from settings store: ${params.currentSettings.defaultAuthorizedShips.join(", ")}`,
    );
  }
  if (params.currentSettings.autoDiscoverChannels !== undefined) {
    effectiveAutoDiscoverChannels = params.currentSettings.autoDiscoverChannels;
    params.log?.(
      `[tlon] Using autoDiscoverChannels from settings store: ${effectiveAutoDiscoverChannels}`,
    );
  }
  if (params.currentSettings.dmAllowlist !== undefined) {
    effectiveDmAllowlist = params.currentSettings.dmAllowlist;
    params.log?.(
      `[tlon] Using dmAllowlist from settings store: ${effectiveDmAllowlist.join(", ")}`,
    );
  }
  if (params.currentSettings.showModelSig !== undefined) {
    effectiveShowModelSig = params.currentSettings.showModelSig;
  }
  if (params.currentSettings.autoAcceptDmInvites !== undefined) {
    effectiveAutoAcceptDmInvites = params.currentSettings.autoAcceptDmInvites;
    params.log?.(
      `[tlon] Using autoAcceptDmInvites from settings store: ${effectiveAutoAcceptDmInvites}`,
    );
  }
  if (params.currentSettings.autoAcceptGroupInvites !== undefined) {
    effectiveAutoAcceptGroupInvites = params.currentSettings.autoAcceptGroupInvites;
    params.log?.(
      `[tlon] Using autoAcceptGroupInvites from settings store: ${effectiveAutoAcceptGroupInvites}`,
    );
  }
  if (params.currentSettings.groupInviteAllowlist !== undefined) {
    effectiveGroupInviteAllowlist = params.currentSettings.groupInviteAllowlist;
    params.log?.(
      `[tlon] Using groupInviteAllowlist from settings store: ${effectiveGroupInviteAllowlist.join(", ")}`,
    );
  }
  if (params.currentSettings.ownerShip) {
    effectiveOwnerShip = normalizeShip(params.currentSettings.ownerShip);
    params.log?.(`[tlon] Using ownerShip from settings store: ${effectiveOwnerShip}`);
  }
  if (params.currentSettings.pendingApprovals?.length) {
    pendingApprovals = params.currentSettings.pendingApprovals;
    params.log?.(`[tlon] Loaded ${pendingApprovals.length} pending approval(s) from settings`);
  }

  return {
    effectiveDmAllowlist,
    effectiveShowModelSig,
    effectiveAutoAcceptDmInvites,
    effectiveAutoAcceptGroupInvites,
    effectiveGroupInviteAllowlist,
    effectiveAutoDiscoverChannels,
    effectiveOwnerShip,
    pendingApprovals,
    currentSettings: params.currentSettings,
  };
}

export function mergeUniqueStrings(base: string[], next?: string[]): string[] {
  if (!next?.length) {
    return [...base];
  }
  const merged = [...base];
  for (const value of next) {
    if (!merged.includes(value)) {
      merged.push(value);
    }
  }
  return merged;
}
