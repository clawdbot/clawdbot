import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpJsonSchemaValidator } from "./mcp-json-schema-validator.js";
import { normalizeMcpToolCatalog } from "./mcp-tool-metadata.js";

function tool(name: string, overrides: Partial<Tool> = {}): Tool {
  return { name, inputSchema: { type: "object" }, ...overrides };
}

describe("normalizeMcpToolCatalog", () => {
  it.each([
    {
      label: "trim-equivalent names",
      colliding: [tool("duplicate"), tool(" duplicate ")],
    },
    {
      label: "a required-task alias",
      colliding: [
        tool(" task ", { execution: { taskSupport: "optional" } }),
        tool("task", { execution: { taskSupport: "required" } }),
      ],
    },
  ])("rejects canonical collisions from $label", ({ colliding }) => {
    const normalized = normalizeMcpToolCatalog(
      [...colliding, tool("healthy")],
      createMcpJsonSchemaValidator(),
    );

    expect(normalized.tools.map((entry) => entry.name)).toEqual(["healthy"]);
    expect(normalized.deniedTools).toEqual([]);
    expect(normalized.metadata.validatorForCall(colliding[0]?.name.trim() ?? "")).toBeUndefined();
  });

  it("filters excluded tools before compiling their output schemas", () => {
    const normalized = normalizeMcpToolCatalog(
      [
        tool("healthy", {
          outputSchema: {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
          },
        }),
        tool("excluded", {
          outputSchema: { type: "object", $ref: "#/$defs/Missing" },
        }),
      ],
      createMcpJsonSchemaValidator(),
      (toolName) => (toolName === "excluded" ? "exclude" : "include"),
    );

    expect(normalized.tools.map((entry) => entry.name)).toEqual(["healthy"]);
    expect(normalized.metadata.validatorForCall("healthy")).toBeTypeOf("function");
    expect(normalized.metadata.validatorForCall("excluded")).toBeUndefined();
  });
});
