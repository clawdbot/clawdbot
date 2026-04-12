import type { ChannelDoctorLegacyConfigRule } from "openclaw/plugin-sdk/channel-contract";

// Runtime config loading already normalizes these aliases without rewriting the
// source file. Keep doctor non-destructive so downgrade paths remain recoverable.
export const DISCORD_LEGACY_CONFIG_RULES: ChannelDoctorLegacyConfigRule[] = [];
