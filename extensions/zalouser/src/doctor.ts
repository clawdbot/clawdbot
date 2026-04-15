import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract.js";
import { isZalouserMutableGroupEntry } from "./security-audit.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export const collectZalouserMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "zalouser",
    detector: isZalouserMutableGroupEntry,
    collectLists: (scope) => {
      const groups = asObjectRecord(scope.account.groups);
      return groups
        ? [
            {
              pathLabel: `${scope.prefix}.groups`,
              list: Object.keys(groups),
            },
          ]
        : [];
    },
  });

export const zalouserDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "topOnly",
  groupModel: "hybrid",
  groupAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: false,
  legacyConfigRules,
  normalizeCompatibilityConfig,
  collectMutableAllowlistWarnings: collectZalouserMutableAllowlistWarnings,
};
