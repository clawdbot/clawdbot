import { copyPluginToolMeta } from "../plugins/tools.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import {
  normalizeToolParameterSchema,
  type ToolParameterSchemaOptions,
} from "./pi-tools-parameter-schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

export { normalizeToolParameterSchema };

function isObjectSchemaWithNoRequiredParams(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const record = schema as Record<string, unknown>;
  const type = record.type;
  const hasObjectType =
    type === "object" || (Array.isArray(type) && type.some((entry) => entry === "object"));
  if (!hasObjectType) {
    return false;
  }
  return !schemaHasRequiredParams(record);
}

function schemaHasRequiredParams(schema: Record<string, unknown>): boolean {
  if (Array.isArray(schema.required) && schema.required.length > 0) {
    return true;
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const variants = schema[key];
    if (!Array.isArray(variants)) {
      continue;
    }
    if (
      variants.some(
        (variant) =>
          variant !== null &&
          typeof variant === "object" &&
          !Array.isArray(variant) &&
          schemaHasRequiredParams(variant as Record<string, unknown>),
      )
    ) {
      return true;
    }
  }
  return false;
}

function addEmptyObjectArgumentPreparation(tool: AnyAgentTool, parameters: unknown): AnyAgentTool {
  if (!isObjectSchemaWithNoRequiredParams(parameters)) {
    return tool;
  }
  return {
    ...tool,
    prepareArguments: (args: unknown) => {
      const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
      return prepared === null || prepared === undefined ? {} : prepared;
    },
  };
}

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
  const parameters = normalizeToolParameterSchema(schema, options);
  return preserveToolMeta({
    ...tool,
    ...addEmptyObjectArgumentPreparation(tool, parameters),
    parameters,
  });
}

/**
 * @deprecated Use normalizeToolParameters with modelProvider instead.
 * This function should only be used for Gemini providers.
 */
export function cleanToolSchemaForGemini(schema: Record<string, unknown>): unknown {
  return normalizeToolParameterSchema(schema, { modelProvider: "gemini" });
}
