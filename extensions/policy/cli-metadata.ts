import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { POLICY_CLI_DESCRIPTOR } from "./src/cli-output-mode.js";

export default definePluginEntry({
  id: "policy",
  name: "Policy",
  description: "Policy CLI metadata",
  register(api) {
    api.registerCli(() => {}, { descriptors: [POLICY_CLI_DESCRIPTOR] });
  },
});
