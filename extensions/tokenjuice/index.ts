// Tokenjuice plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createTokenjuiceAgentToolResultMiddleware } from "./tool-result-middleware.js";

export default definePluginEntry({
  id: "tokenjuice",
  name: "tokenjuice",
  description:
    "Compacts exec and bash tool results for OpenClaw-embedded runs and OpenClaw dynamic tools in the Codex app-server harness. Native codex-rs bash/exec results are returned unchanged.",
  register(api) {
    api.registerAgentToolResultMiddleware(createTokenjuiceAgentToolResultMiddleware(), {
      runtimes: ["openclaw", "codex"],
    });
  },
});
