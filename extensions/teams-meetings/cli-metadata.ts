import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { TEAMS_MEETINGS_CLI_DESCRIPTOR } from "./src/cli-output-mode.js";

export default definePluginEntry({
  id: "teams-meetings",
  name: "Microsoft Teams meetings",
  description: "Microsoft Teams meetings CLI metadata",
  register(api) {
    api.registerCli(() => {}, { descriptors: [TEAMS_MEETINGS_CLI_DESCRIPTOR] });
  },
});
