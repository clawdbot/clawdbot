import type { ClawdbotPluginApi } from "../../src/plugins/types.js";

import { bluebubblesPlugin } from "./src/channel.js";
import { handleBlueBubblesWebhookRequest } from "./src/monitor.js";

const plugin = {
  id: "bluebubbles",
  name: "BlueBubbles",
  description: "BlueBubbles channel plugin (macOS app)",
  register(api: ClawdbotPluginApi) {
    api.registerChannel({ plugin: bluebubblesPlugin });
    api.registerHttpHandler(handleBlueBubblesWebhookRequest);
  },
};

export default plugin;
