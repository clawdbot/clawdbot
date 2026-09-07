// Signal doctor resolves ambiguous shipped auto-mode endpoints once and persists a concrete kind.
import type { ChannelDoctorAdapter } from "openclaw/plugin-sdk/channel-contract";
import { normalizeCompatibilityConfig } from "../doctor-contract-api.js";
import { listSignalAccountKeyCollisionWarnings } from "./account-key-repair.js";
import { migrateLegacySignalTransportConfig } from "./config-compat.js";

export const signalDoctor: ChannelDoctorAdapter = {
  normalizeCompatibilityConfig,
  // Colliding account keys are the one account-key shape doctor refuses to repair, so nothing
  // else would report them: a preview warning keeps the dead entry from staying invisible.
  collectPreviewWarnings: ({ cfg }) =>
    listSignalAccountKeyCollisionWarnings(cfg.channels?.signal?.accounts),
  cleanStaleConfig: async ({ cfg }) => {
    const { detectSignalTransport } = await import("./transport-detection.runtime.js");
    return await migrateLegacySignalTransportConfig({ cfg, detect: detectSignalTransport });
  },
};
