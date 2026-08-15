import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { GOOGLE_MEET_CLI_DESCRIPTOR } from "./src/cli-output-mode.js";

export default definePluginEntry({
  id: "google-meet",
  name: "Google Meet",
  description: "Google Meet CLI metadata",
  register(api) {
    api.registerCli(() => {}, { descriptors: [GOOGLE_MEET_CLI_DESCRIPTOR] });
  },
});
