import {
  normalizeToolParameterSchema,
  type ToolParameterSchemaOptions,
} from "@openclaw/ai/internal/openai";
/**
 * Tool schema normalization wrappers.
 * Applies provider-compatible parameter schema cleanup while preserving plugin
 * and channel metadata on normalized tools.
 */
import { copyPluginToolMeta } from "../plugins/tools.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { copyBeforeToolCallHookMarker } from "./before-tool-call-metadata.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import { copyToolTerminalPresentation } from "./tool-terminal-presentation.js";

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

/** Normalize a tool's parameter schema for the selected provider/model. */
export function normalizeToolParameters(
  tool: AnyAgentTool,
  options?: ToolParameterSchemaOptions,
): AnyAgentTool {
  function preserveToolMeta(target: AnyAgentTool): AnyAgentTool {
    copyPluginToolMeta(tool, target);
    copyChannelAgentToolMeta(tool as never, target as never);
    copyBeforeToolCallHookMarker(tool, target);
    copyToolTerminalPresentation(tool, target);
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
