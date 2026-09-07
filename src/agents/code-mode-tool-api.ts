import type { CodeModeApiVirtualFile } from "./code-mode-mcp-api.js";
import { toolSchemaDeclaration } from "./tool-schema-hints.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";

/** Generate only on API.read, from the same effective schemas as describe(). */
export function createCodeModeToolApiFile(
  callableName: string,
  entry: Pick<ToolSearchCatalogEntry, "source" | "parameters" | "outputSchema">,
): CodeModeApiVirtualFile {
  const trusted = entry.source === "openclaw";
  const input = trusted ? toolSchemaDeclaration(entry.parameters) : "unknown";
  const output = trusted ? toolSchemaDeclaration(entry.outputSchema) : "unknown";
  const content = [
    "// Generated from the effective tool contract. Unsupported shapes stay unknown.",
    "// JSON Schema validation owns constraints; describe() exposes the original schema.",
    "// Values enter the guest intact or reject when program-data admission is full.",
    "declare function " + callableName + "(input: " + input + "): Promise<" + output + ">;",
  ].join("\n");
  return {
    path: "tools/" + callableName + ".d.ts",
    content,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}
