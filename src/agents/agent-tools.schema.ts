import {
  normalizeToolParameterSchema,
  type ToolParameterSchemaOptions,
} from "@openclaw/ai/internal/tool-schema";
/**
 * Tool schema normalization wrappers.
 * Applies provider-compatible parameter schema cleanup while preserving
 * identity-backed metadata on normalized tools.
 */
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

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

/** Normalize a tool's parameter schema for the selected provider/model. */
export function normalizeToolParameters(
  tool: AnyAgentTool,
  options?: ToolParameterSchemaOptions,
): AnyAgentTool {
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : undefined;
  if (!schema) {
    return tool;
  }
  const parameters = normalizeToolParameterSchema(schema, options);
  const normalized = { ...tool, parameters };
  if (isObjectSchemaWithNoRequiredParams(parameters)) {
    normalized.prepareArguments = (args: unknown) => {
      const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
      return prepared === null || prepared === undefined ? {} : prepared;
    };
  }
  return copyAgentToolMetadata(tool, normalized);
}
