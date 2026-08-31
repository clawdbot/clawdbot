import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMcpJsonSchemaValidator } from "./mcp-json-schema-validator.js";
import { normalizeMcpToolCatalog } from "./mcp-tool-metadata.js";

function tool(name: string, overrides: Partial<Tool> = {}): Tool {
  return { name, inputSchema: { type: "object" }, ...overrides };
}

describe("normalizeMcpToolCatalog", () => {
  it.each([
    ["IDN hosts", "https://bücher.example/value", "https://xn--bcher-kva.example/value"],
    ["relative references", "child", "./child"],
    ["local fragments", "#value", "#value"],
    ["reserved path escapes", "a%3Ab", "a%3Ab"],
  ])("validates tool output schemas with %s", (_label, id, ref) => {
    const normalized = normalizeMcpToolCatalog(
      [
        tool("referenced", {
          outputSchema: {
            $id: "https://schema.example/root",
            type: "object",
            definitions: { value: { $id: id, type: "string" } },
            properties: { value: { $ref: ref } },
            required: ["value"],
          },
        }),
      ],
      createMcpJsonSchemaValidator(),
    );
    const validate = normalized.metadata.validatorForCall("referenced")!;

    expect(() => validate({ content: [], structuredContent: { value: "ok" } })).not.toThrow();
    expect(() => validate({ content: [], structuredContent: { value: 1 } })).toThrow(
      "Structured content does not match the tool's output schema",
    );
  });

  it("keeps nested hostname escapes distinct when resolving tool output schemas", () => {
    const validate = createMcpJsonSchemaValidator().getValidator({
      $id: "https://schema.example/root",
      definitions: {
        encoded: { $id: "https://127%252e0%252e0%252e1/value", const: "encoded" },
        plain: { $id: "https://127.0.0.1/value", const: "plain" },
      },
      $ref: "https://127%252e0%252e0%252e1/value",
    });

    expect(validate("encoded").valid).toBe(true);
    expect(validate("plain").valid).toBe(false);
  });

  it.each([
    ["encoded scheme delimiters", "%2f%2fschema.example:/value", "URI scheme is malformed"],
    ["invalid IPv6", "https://[1:2:3::4::5]/value", "URI host is malformed"],
    ["malformed percent escapes", "https://schema.example/%ZZ", "malformed percent-encoding"],
  ])("rejects %s in tool output schema references", (_label, ref, error) => {
    expect(() =>
      createMcpJsonSchemaValidator().getValidator({
        $id: "https://schema.example/root",
        definitions: { value: { $id: ref, type: "string" } },
        $ref: ref,
      }),
    ).toThrow(error);
  });

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
    expect(normalized.excludedTools.map((entry) => entry.name)).toEqual(
      colliding.map((entry) => entry.name.trim()),
    );
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
        tool("task_only", { execution: { taskSupport: "required" } }),
      ],
      createMcpJsonSchemaValidator(),
      (toolName) => (toolName === "excluded" ? "exclude" : "include"),
    );

    expect(normalized.tools.map((entry) => entry.name)).toEqual(["healthy"]);
    expect(normalized.excludedTools.map((entry) => entry.name)).toEqual(["excluded", "task_only"]);
    expect(normalized.metadata.validatorForCall("healthy")).toBeTypeOf("function");
    expect(normalized.metadata.validatorForCall("excluded")).toBeUndefined();
  });
});
