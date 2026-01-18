import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { zalouserPlugin } from "./src/channel.js";
import { ZalouserToolSchema, executeZalouserTool } from "./src/tool.js";
import { setZalouserRuntime } from "./src/runtime.js";

const plugin = {
  id: "zalouser",
  name: "Zalo Personal",
  description: "Zalo personal account messaging via zca-cli",
  register(api: ClawdbotPluginApi) {
    setZalouserRuntime(api.runtime);
    // Register channel plugin (for onboarding & gateway)
    api.registerChannel(zalouserPlugin);

    // Register agent tool
    api.registerTool({
      name: "zalouser",
      label: "Zalo Personal",
      description:
        "Send messages and access data via Zalo personal account. " +
        "Actions: send (text message), image (send image URL), link (send link), " +
        "friends (list/search friends), groups (list groups), me (profile info), status (auth check).",
      parameters: ZalouserToolSchema,
      execute: executeZalouserTool,
    });
  },
};

export default plugin;
