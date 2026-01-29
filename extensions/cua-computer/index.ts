/**
 * Cua Computer Plugin
 *
 * Provides GUI automation via cua-computer-server - screenshots, clicks, typing, scrolling.
 *
 * @see https://github.com/trycua/cua/tree/main/libs/python/computer-server
 */

import type { ClawdbotPluginDefinition } from "../../src/plugins/types.js";
import { createComputerTool } from "./computer-tool.js";

interface CuaComputerConfig {
  serverUrl?: string;
}

const plugin: ClawdbotPluginDefinition = {
  id: "cua-computer",
  name: "Cua Computer",
  description: "GUI automation via cua-computer-server",

  register(api) {
    const config = api.pluginConfig as CuaComputerConfig | undefined;

    api.registerTool(
      createComputerTool({
        defaultServerUrl: config?.serverUrl,
        config: api.config,
      }),
    );
  },
};

export default plugin;
