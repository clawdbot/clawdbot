/**
 * Doctor contract metadata for Anthropic and Claude CLI state. It declares
 * session/auth ownership so doctor cleanup can route stale state correctly.
 */
import type { DoctorSessionRouteStateOwner } from "openclaw/plugin-sdk/runtime-doctor";

/** Anthropic currently has no legacy config migrations. */
export const legacyConfigRules = [];

/** Session-route ownership metadata for Anthropic API and Claude CLI sessions. */
export const sessionRouteStateOwners: DoctorSessionRouteStateOwner[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    providerIds: ["anthropic", "claude-cli"],
    runtimeIds: ["claude-cli"],
    cliSessionKeys: ["claude-cli"],
    authProfilePrefixes: ["anthropic:", "claude-cli:"],
  },
];
