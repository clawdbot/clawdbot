export const HOSTING_PROFILE_IDS = ["local", "container", "reverse-proxy", "node-mode"] as const;

export type HostingProfileId = (typeof HOSTING_PROFILE_IDS)[number];

export const HOSTING_PROFILE_ENV = "OPENCLAW_HOSTING_PROFILE";

export const HOSTING_PROFILE_CONTRACT_VERSION = 1 as const;
