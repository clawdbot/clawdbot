import type { OpenClawPluginDefinition } from "../plugins/types.js";

export type BundledNodeHostPlugin = {
  definition: OpenClawPluginDefinition & { id: string; name: string };
  enabledByDefault: boolean;
};

// The macOS worker build replaces this source-only placeholder with static
// extension imports. Core typechecking must not absorb extension DOM graphs.
export const MAC_NODE_HOST_PLUGIN_DEFINITIONS: readonly BundledNodeHostPlugin[] = [];
