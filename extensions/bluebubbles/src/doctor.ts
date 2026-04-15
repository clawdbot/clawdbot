import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import {
  legacyConfigRules as BLUEBUBBLES_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeBlueBubblesCompatibilityConfig,
} from "./doctor-contract.js";

export const bluebubblesDoctor: ChannelDoctorAdapter = {
  legacyConfigRules: BLUEBUBBLES_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeBlueBubblesCompatibilityConfig,
};
