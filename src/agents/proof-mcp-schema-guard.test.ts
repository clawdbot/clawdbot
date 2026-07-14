/**
 * Runtime proof for openclaw/openclaw#107309.
 * Verifies that tryNormalizeToolParameterSchema catches exceptions from
 * malformed input schemas and returns undefined, while healthy schemas
 * are normalized successfully. Tests the actual guard function directly.
 */
import { describe, it, expect } from "vitest";
import { tryNormalizeToolParameterSchema } from "./agent-bundle-mcp-schema-guard.js";
import type { McpCatalogTool } from "./agent-bundle-mcp-types.js";

function makeTool(overrides: Partial<McpCatalogTool> = {}): McpCatalogTool {
  return {
    serverName: "test-server",
    safeServerName: "test",
    toolName: "test-tool",
    description: "test",
    fallbackDescription: "fallback",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  } as unknown as McpCatalogTool;
}

describe("proof: mcp-schema-guard (#106665)", () => {
  it("normalizes a healthy schema successfully", () => {
    const tool = makeTool({
      toolName: "healthy-tool",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    });
    const result = tryNormalizeToolParameterSchema(tool);
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");
  });

  it("returns undefined when normalizeToolParameterSchema throws", () => {
    // A schema with a getter that throws will cause normalizeToolParameterSchema to throw.
    const throwingSchema: Record<string, unknown> = {
      get type(): string {
        throw new Error("malformed schema getter");
      },
    };
    const tool = makeTool({
      toolName: "malformed-throwing",
      inputSchema: throwingSchema as never,
    });
    const result = tryNormalizeToolParameterSchema(tool);
    expect(result).toBeUndefined();
  });

  it("handles null inputSchema gracefully", () => {
    const tool = makeTool({
      toolName: "null-schema",
      inputSchema: null as never,
    });
    // null may return null or undefined depending on normalizeToolParameterSchema behavior;
    // the key invariant is no exception is thrown.
    const result = tryNormalizeToolParameterSchema(tool);
    expect(result).toBeTypeOf("object");
  });

  it("processes mixed healthy and throwing tools without crashing", () => {
    const throwingSchema: Record<string, unknown> = {
      get type(): string {
        throw new Error("malformed");
      },
    };
    const tools = [
      makeTool({ toolName: "healthy-a", inputSchema: { type: "object", properties: {} } }),
      makeTool({ toolName: "malformed", inputSchema: throwingSchema as never }),
      makeTool({ toolName: "healthy-b", inputSchema: { type: "object", properties: {} } }),
    ];

    const results = tools.map((t) => ({
      name: t.toolName,
      result: tryNormalizeToolParameterSchema(t),
    }));

    const [healthyA, malformed, healthyB] = results;
    expect(healthyA).toBeDefined();
    expect(malformed).toBeDefined();
    expect(healthyB).toBeDefined();

    const proof = {
      proof: "mcp-schema-guard",
      issue: "#106665",
      setup: "3 tools (2 healthy, 1 malformed throwing schema)",
      result: {
        totalProcessed: results.length,
        healthyA: healthyA!.result != null,
        malformed: malformed!.result === undefined,
        healthyB: healthyB!.result != null,
      },
      passed:
        healthyA!.result != null && malformed!.result === undefined && healthyB!.result != null,
    };

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(proof, null, 2));

    expect(healthyA!.result).not.toBeNull();
    expect(malformed!.result).toBeUndefined();
    expect(healthyB!.result).not.toBeNull();
  });
});
