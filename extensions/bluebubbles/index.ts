import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { bluebubblesPlugin } from "./src/channel.js";
import { handleBlueBubblesWebhookRequest } from "./src/monitor.js";
import { setBlueBubblesRuntime } from "./src/runtime.js";

const plugin = {
  id: "bluebubbles",
  name: "BlueBubbles",
  description: "BlueBubbles channel plugin (macOS app)",
  register(api: ClawdbotPluginApi) {
    setBlueBubblesRuntime(api.runtime);
    api.registerChannel({ plugin: bluebubblesPlugin });
    api.registerHttpHandler(handleBlueBubblesWebhookRequest);
  },
};

export default plugin;
