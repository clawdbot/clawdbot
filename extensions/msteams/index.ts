import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { msteamsPlugin } from "./src/channel.js";

const plugin = {
  id: "msteams",
  name: "Microsoft Teams",
  description: "Microsoft Teams channel plugin (Bot Framework)",
  register(api: ClawdbotPluginApi) {
    api.registerChannel({ plugin: msteamsPlugin });
  },
};

export default plugin;
