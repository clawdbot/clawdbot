import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createSessionShareNodeCommands,
  createSessionShareNodeInvokePolicies,
} from "./src/node-commands.js";
import { createSessionShareCatalog } from "./src/session-catalog.js";

export default definePluginEntry({
  id: "session-share",
  name: "Session Share",
  description: "Read-only OpenClaw sessions on paired gateways",
  register(api) {
    api.registerSessionCatalog(createSessionShareCatalog(api));
    for (const command of createSessionShareNodeCommands(api)) {
      api.registerNodeHostCommand(command);
    }
    for (const policy of createSessionShareNodeInvokePolicies()) {
      api.registerNodeInvokePolicy(policy);
    }
  },
});
