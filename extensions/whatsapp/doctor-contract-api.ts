import type { ChannelDoctorLegacyConfigRule } from "openclaw/plugin-sdk/channel-contract";

export { normalizeCompatibilityConfig } from "./src/doctor-contract.js";

// WhatsApp currently exposes doctor compatibility fixes without extra legacy
// rule scans. Keep that empty answer on a lightweight contract surface so
// config validation stays off the broad contract-api import path.
export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [];
