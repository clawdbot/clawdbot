import { loadConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { handleMatrixAction } from "./matrix-actions.js";
import { MatrixToolSchema } from "./matrix-schema.js";

export function createMatrixTool(): AnyAgentTool {
  return {
    label: "Matrix",
    name: "matrix",
    description: "Manage Matrix messages, reactions, and pins.",
    parameters: MatrixToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = loadConfig();
      return await handleMatrixAction(params, cfg);
    },
  };
}
