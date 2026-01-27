import type { MoltbotPluginApi } from "../../src/plugins/types.js";

import { createLlmTaskTool } from "./src/llm-task-tool.js";

export default function register(api: MoltbotPluginApi) {
  api.registerTool(createLlmTaskTool(api), { optional: true });
}
