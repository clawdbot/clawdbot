import { copyPluginToolMeta } from "../plugins/tools.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import {
  normalizeToolParameterSchema,
  type ToolParameterSchemaOptions,
} from "./pi-tools-parameter-schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

export { normalizeToolParameterSchema };

export function normalizeToolParameters(
  tool: AnyAgentTool,
  options?: ToolParameterSchemaOptions,
): AnyAgentTool {
  function preserveToolMeta(target: AnyAgentTool): AnyAgentTool {
    copyPluginToolMeta(tool, target);
    copyChannelAgentToolMeta(tool as never, target as never);
    return target;
  }
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : undefined;
  if (!schema) {
    return tool;
  }
  return preserveToolMeta({
    ...tool,
    parameters: normalizeToolParameterSchema(schema, options),
  });
}

/**
 * @deprecated Use normalizeToolParameters with modelProvider instead.
 * This function should only be used for Gemini providers.
 */
export function cleanToolSchemaForGemini(schema: Record<string, unknown>): unknown {
  return normalizeToolParameterSchema(schema, { modelProvider: "gemini" });
}
