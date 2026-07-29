// Private runtime barrel for the bundled Nostr extension.
// Keep this barrel thin and aligned with the local extension surface.

export type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
export type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
