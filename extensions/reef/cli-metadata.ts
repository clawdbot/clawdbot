// Reef plugin module implements cli metadata behavior.
import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { registerReefCliMetadata } from "./src/cli-metadata.js";

export { registerReefCliMetadata } from "./src/cli-metadata.js";

export default definePluginEntry({
  id: "reef",
  name: "Reef",
  description: "Guarded end-to-end encrypted claw channel",
  register: registerReefCliMetadata,
});
