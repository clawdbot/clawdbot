import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createTokenjuiceOpenClawEmbeddedExtension } from "./runtime-api.js";

export default definePluginEntry({
  id: "tokenjuice",
  name: "tokenjuice",
  description: "Compacts exec and bash tool results with tokenjuice reducers.",
  register(api) {
    api.registerEmbeddedExtensionFactory(createTokenjuiceOpenClawEmbeddedExtension());
  },
});
