import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerBedrockMantlePlugin } from "./register.sync.runtime.js";

export default definePluginEntry({
  id: "amazon-bedrock-mantle",
  name: "Amazon Bedrock Mantle Provider",
  description: "Bundled Amazon Bedrock Mantle (OpenAI-compatible) provider plugin",
  register(api) {
    registerBedrockMantlePlugin(api);
  },
});
