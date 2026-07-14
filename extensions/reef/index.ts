import {
  defineBundledChannelEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { registerReefCliMetadata } from "./cli-metadata.js";

const loadReefCommandsRuntime = createLazyRuntimeModule(() => import("./commands.runtime.js"));

function registerReefFullRuntime(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "reef",
    description: "Manage Reef friends and owner review approvals",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (params) => {
      const { handleReefCommand } = await loadReefCommandsRuntime();
      return await handleReefCommand(params);
    },
  });
}

export default defineBundledChannelEntry({
  id: "reef",
  name: "Reef",
  description: "Guarded end-to-end encrypted claw channel",
  importMetaUrl: import.meta.url,
  plugin: { specifier: "./channel-plugin-api.js", exportName: "reefPlugin" },
  outbound: { specifier: "./api.js", exportName: "reefOutboundAdapter" },
  runtime: { specifier: "./runtime-api.js", exportName: "setReefRuntime" },
  registerCliMetadata: registerReefCliMetadata,
  registerFull: registerReefFullRuntime,
});
