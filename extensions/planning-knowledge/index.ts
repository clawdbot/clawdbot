import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import {
  createPlanningKnowledgeCaptureTool,
  createPlanningKnowledgeSearchTool,
  planningKnowledgeConfigSchema,
  planningKnowledgeCaptureParameters,
  planningKnowledgeSearchParameters,
  resolvePlanningKnowledgeConfig,
} from "./src/planning-knowledge-tool.js";

export default defineToolPlugin({
  id: "planning-knowledge",
  name: "Planning Knowledge",
  description:
    "Read-only access to Oliver's Planning-owned personal Knowledge Notes. Canonical refs remain note:notes/knowledge/<slug>.",
  configSchema: planningKnowledgeConfigSchema,
  tools: (tool) => [
    tool({
      name: "planning_knowledge_search",
      label: "Planning Knowledge Search",
      description:
        "Search Oliver's saved personal Planning Knowledge Notes through the configured OneLibrary derived index. Use for questions about what Oliver has saved. Results are private, current-truth eligible, and carry canonical note:notes/knowledge/<slug> citations. Do not use for generic knowledge, tasks, or books/media.",
      parameters: planningKnowledgeSearchParameters,
      optional: true,
      factory: ({ api, config, toolContext }) => {
        if (toolContext.senderIsOwner === false) {
          return null;
        }
        const resolved = resolvePlanningKnowledgeConfig(config, api.resolvePath);
        return resolved ? createPlanningKnowledgeSearchTool(resolved) : null;
      },
    }),
    tool({
      name: "planning_knowledge_capture",
      label: "Planning Knowledge Capture (disabled)",
      description:
        "Recognize an explicit request to save content as a personal Planning Knowledge Note. PLN-500A is retrieval-only: never write, edit, archive, or create a task from this tool. For mixed requests, route any operational reminder separately.",
      parameters: planningKnowledgeCaptureParameters,
      optional: true,
      factory: ({ toolContext }) =>
        toolContext.senderIsOwner === false ? null : createPlanningKnowledgeCaptureTool(),
    }),
  ],
});
