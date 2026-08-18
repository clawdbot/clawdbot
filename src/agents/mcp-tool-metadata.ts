import {
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";

type ToolOutputValidator = JsonSchemaValidator<unknown>;

export type McpToolCatalogMetadata = {
  isRequiredTaskTool(toolName: string): boolean;
  validateResult(toolName: string, result: CallToolResult): void;
};

/** Owns complete tool metadata after all list pages have been merged. */
export function createMcpToolCatalogMetadata(
  tools: readonly Tool[],
  schemaValidator: jsonSchemaValidator,
): McpToolCatalogMetadata {
  const outputValidators = new Map<string, ToolOutputValidator>();
  const requiredTaskTools = new Set<string>();
  for (const tool of tools) {
    if (tool.outputSchema) {
      outputValidators.set(tool.name, schemaValidator.getValidator(tool.outputSchema));
    }
    if (tool.execution?.taskSupport === "required") {
      requiredTaskTools.add(tool.name);
    }
  }
  return {
    isRequiredTaskTool: (toolName) => requiredTaskTools.has(toolName),
    validateResult(toolName, result) {
      const validator = outputValidators.get(toolName);
      if (!validator) {
        return;
      }
      if (result.structuredContent === undefined && result.isError !== true) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Tool ${toolName} has an output schema but did not return structured content`,
        );
      }
      if (result.structuredContent === undefined) {
        return;
      }
      const validation = validator(result.structuredContent);
      if (!validation.valid) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Structured content does not match the tool's output schema: ${validation.errorMessage}`,
        );
      }
    },
  };
}
