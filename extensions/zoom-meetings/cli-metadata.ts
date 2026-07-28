import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { ZOOM_MEETINGS_CLI_DESCRIPTOR } from "./src/cli-output-mode.js";

export default definePluginEntry({
  id: "zoom-meetings",
  name: "Zoom meetings",
  description: "Zoom meetings CLI metadata",
  register(api) {
    api.registerCli(() => {}, { descriptors: [ZOOM_MEETINGS_CLI_DESCRIPTOR] });
  },
});
