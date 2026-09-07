import type { JsonSchemaValue } from "../plugins/schema-validator.js";
import type { CodeModeApiVirtualFile } from "./code-mode-mcp-api.js";
import { toolSchemaDeclaration } from "./tool-schema-hints.js";
import type { ToolSearchCatalogEntry } from "./tool-search-types.js";

/** Generate only on API.read, from the same effective schemas as describe(). */
export async function createCodeModeToolApiFile(
  callableName: string,
  entry: Pick<ToolSearchCatalogEntry, "source" | "parameters" | "outputSchema">,
): Promise<CodeModeApiVirtualFile> {
  const trusted = entry.source === "openclaw";
  const input = trusted ? toolSchemaDeclaration(entry.parameters) : "unknown";
  const output = trusted ? toolSchemaDeclaration(entry.outputSchema) : "unknown";
  let optional = false;
  if (trusted) {
    const { validateJsonSchemaValue } = await import("../plugins/schema-validator.js");
    try {
      optional = validateJsonSchemaValue({
        // SAFETY: The canonical validator checks the schema shape before compiling it.
        schema: (entry.parameters ?? {}) as JsonSchemaValue,
        cacheKey: `code-mode-omitted-input:${JSON.stringify(entry.parameters)}`,
        value: {},
      }).ok;
    } catch {
      // Invalid or unsupported contracts must never advertise optional required input.
    }
  }
  const content = [
    "// Generated from the effective tool contract. Unsupported shapes stay unknown.",
    "// JSON Schema validation owns constraints; describe() exposes the original schema.",
    "// Values enter the guest intact or reject when program-data admission is full.",
    "declare function " +
      callableName +
      (optional ? "(input?: " : "(input: ") +
      input +
      "): Promise<" +
      output +
      ">;",
  ].join("\n");
  return {
    path: "tools/" + callableName + ".d.ts",
    content,
    bytes: Buffer.byteLength(content, "utf8"),
  };
}
