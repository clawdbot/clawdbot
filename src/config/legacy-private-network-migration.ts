// Doctor migration for the retired flat `allowPrivateNetwork` channel key.
//
// Kept as a leaf beside the other channel alias migrations, not in
// `plugin-sdk/ssrf-policy`: these helpers only reshape config records, while
// that module value-loads the SSRF runtime (DNS, proxy state, logging). Doctor
// enumeration cold-loads every declaring plugin's contract closure, so a
// closure reaching this policy through the runtime graph paid for hundreds of
// modules it never called.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "../plugin-sdk/channel-contract.js";
import { normalizeChannelConfigEntries } from "./channel-doctor-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Detects the retired flat `allowPrivateNetwork` key before doctor migration. */
export function hasLegacyFlatAllowPrivateNetworkAlias(value: unknown): boolean {
  const entry = asNullableRecord(value);
  return Boolean(entry && Object.hasOwn(entry, "allowPrivateNetwork"));
}

/** Moves flat private-network config into `network.dangerouslyAllowPrivateNetwork`. */
export function migrateLegacyFlatAllowPrivateNetworkAlias(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  if (!hasLegacyFlatAllowPrivateNetworkAlias(params.entry)) {
    return { entry: params.entry, changed: false };
  }

  const legacyAllowPrivateNetwork = params.entry.allowPrivateNetwork;
  const currentNetworkRecord = asNullableRecord(params.entry.network);
  const currentNetwork = currentNetworkRecord ? { ...currentNetworkRecord } : {};
  const currentDangerousAllowPrivateNetwork = currentNetwork.dangerouslyAllowPrivateNetwork;

  let resolvedDangerousAllowPrivateNetwork: unknown = currentDangerousAllowPrivateNetwork;
  if (typeof currentDangerousAllowPrivateNetwork === "boolean") {
    // The canonical key wins when both shapes are present.
    resolvedDangerousAllowPrivateNetwork = currentDangerousAllowPrivateNetwork;
  } else if (typeof legacyAllowPrivateNetwork === "boolean") {
    resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork;
  } else if (currentDangerousAllowPrivateNetwork === undefined) {
    resolvedDangerousAllowPrivateNetwork = legacyAllowPrivateNetwork;
  }

  delete currentNetwork.dangerouslyAllowPrivateNetwork;
  if (resolvedDangerousAllowPrivateNetwork !== undefined) {
    currentNetwork.dangerouslyAllowPrivateNetwork = resolvedDangerousAllowPrivateNetwork;
  }

  const nextEntry = { ...params.entry };
  delete nextEntry.allowPrivateNetwork;
  if (Object.keys(currentNetwork).length > 0) {
    nextEntry.network = currentNetwork;
  } else {
    delete nextEntry.network;
  }

  params.changes.push(
    `Moved ${params.pathPrefix}.allowPrivateNetwork → ${params.pathPrefix}.network.dangerouslyAllowPrivateNetwork (${String(resolvedDangerousAllowPrivateNetwork)}).`,
  );
  return { entry: nextEntry, changed: true };
}

function hasLegacyAllowPrivateNetworkInAccounts(value: unknown): boolean {
  const accounts = asNullableRecord(value);
  return Boolean(
    accounts &&
    Object.values(accounts).some((account) =>
      hasLegacyFlatAllowPrivateNetworkAlias(asNullableRecord(account) ?? {}),
    ),
  );
}

/** Build doctor rules that migrate legacy private-network aliases for one channel config. */
export function createLegacyPrivateNetworkDoctorContract(params: { channelKey: string }): {
  legacyConfigRules: ChannelDoctorLegacyConfigRule[];
  normalizeCompatibilityConfig: (params: { cfg: OpenClawConfig }) => ChannelDoctorConfigMutation;
} {
  const pathPrefix = `channels.${params.channelKey}`;
  return {
    legacyConfigRules: [
      {
        path: ["channels", params.channelKey],
        message: `${pathPrefix}.allowPrivateNetwork is legacy; use ${pathPrefix}.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".`,
        match: (value) => hasLegacyFlatAllowPrivateNetworkAlias(asNullableRecord(value) ?? {}),
      },
      {
        path: ["channels", params.channelKey, "accounts"],
        message: `${pathPrefix}.accounts.<id>.allowPrivateNetwork is legacy; use ${pathPrefix}.accounts.<id>.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".`,
        match: hasLegacyAllowPrivateNetworkInAccounts,
      },
    ],
    normalizeCompatibilityConfig: ({ cfg }) => {
      // A channel array can expose numeric keys but must remain invalid config.
      if (!asNullableRecord(cfg.channels)) {
        return { config: cfg, changes: [] };
      }
      return normalizeChannelConfigEntries({
        cfg,
        channelId: params.channelKey,
        normalizeEntry: migrateLegacyFlatAllowPrivateNetworkAlias,
      });
    },
  };
}
