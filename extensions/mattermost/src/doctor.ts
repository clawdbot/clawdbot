// Mattermost plugin module implements doctor behavior.
import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import {
  buildMutableAllowEntryDetector,
  collectStandardAllowlistLists,
  createDangerousNameMatchingMutableAllowlistWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  legacyConfigRules as MATTERMOST_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeMattermostCompatibilityConfig,
} from "./doctor-contract.js";

const isMattermostMutableAllowEntry = buildMutableAllowEntryDetector({
  stableIdPattern: /^(?:(?:mattermost|user):)?@?[a-z0-9]{26}$/i,
});

const collectMattermostMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "mattermost",
    detector: isMattermostMutableAllowEntry,
    collectLists: (scope) => collectStandardAllowlistLists(scope),
  });

export const mattermostDoctor: ChannelDoctorAdapter = {
  legacyConfigRules: MATTERMOST_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeMattermostCompatibilityConfig,
  collectMutableAllowlistWarnings: collectMattermostMutableAllowlistWarnings,
};
