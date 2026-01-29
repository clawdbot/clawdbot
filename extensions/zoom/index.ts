import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { zoomPlugin } from "./src/channel.js";
import { setZoomRuntime } from "./src/runtime.js";

export { monitorZoomProvider } from "./src/monitor.js";

const plugin = {
  id: "zoom",
  name: "Zoom Team Chat",
  description: "Zoom Team Chat channel plugin (S2S OAuth)",
  configSchema: emptyPluginConfigSchema(),
  register(api: MoltbotPluginApi) {
    setZoomRuntime(api.runtime);
    api.registerChannel({ plugin: zoomPlugin });
  },
};

export default plugin;
