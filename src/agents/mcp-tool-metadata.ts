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

type McpToolResultValidator = (result: CallToolResult) => void;

type McpToolCatalogDisposition = "include" | "denied" | "exclude";

export type McpToolCatalogMetadata = {
  validatorForCall(toolName: string): McpToolResultValidator | undefined;
};

/** Canonicalizes one server catalog before policy, publication, and call metadata diverge. */
export function normalizeMcpToolCatalog(
  tools: readonly Tool[],
  schemaValidator: jsonSchemaValidator,
  classify: (toolName: string) => McpToolCatalogDisposition = () => "include",
): {
  tools: Tool[];
  deniedTools: Tool[];
  excludedTools: Tool[];
  metadata: McpToolCatalogMetadata;
} {
  const canonicalNames = tools.map((tool) => tool.name.trim());
  const nameCounts = new Map<string, number>();
  for (const toolName of canonicalNames) {
    if (toolName) {
      nameCounts.set(toolName, (nameCounts.get(toolName) ?? 0) + 1);
    }
  }

  const included: Tool[] = [];
  const deniedTools: Tool[] = [];
  const excludedTools: Tool[] = [];
  const resultValidators = new Map<string, McpToolResultValidator>();
  for (const [index, sourceTool] of tools.entries()) {
    const toolName = canonicalNames[index] ?? "";
    // One wire name is one operation. Ambiguous aliases are safer omitted than
    // published under multiple model names with conflicting metadata.
    if (!toolName) {
      continue;
    }
    const tool = { ...sourceTool, name: toolName };
    if (nameCounts.get(toolName) !== 1 || sourceTool.execution?.taskSupport === "required") {
      excludedTools.push(tool);
      continue;
    }
    const disposition = classify(toolName);
    if (disposition === "exclude") {
      excludedTools.push({ ...sourceTool, name: toolName });
      continue;
    }
    if (disposition === "include") {
      included.push(tool);
      if (tool.outputSchema) {
        const validator: JsonSchemaValidator<unknown> = schemaValidator.getValidator(
          tool.outputSchema,
        );
        resultValidators.set(toolName, (result) => {
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
        });
      }
    } else {
      deniedTools.push(tool);
    }
  }

  return {
    tools: included,
    excludedTools,
    metadata: {
      validatorForCall(toolName) {
        return resultValidators.get(toolName);
      },
    },
    deniedTools,
  };
}
