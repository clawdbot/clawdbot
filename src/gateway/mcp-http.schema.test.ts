// Gateway tests cover MCP loopback schema projection behavior.
import { describe, expect, it } from "vitest";
import { buildMcpToolSchema } from "./mcp-http.schema.js";

describe("buildMcpToolSchema", () => {
  it("keeps union schema properties named like Object prototype keys", () => {
    const [entry] = buildMcpToolSchema([
      {
        name: "proof_tool",
        description: "proof",
        parameters: {
          anyOf: [
            {
              type: "object",
              properties: {
                toString: { type: "string" },
              },
              required: ["toString"],
            },
          ],
        },
      } as never,
    ]);

    const inputSchema = entry?.inputSchema as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;
    const propertySchema = inputSchema?.properties?.["toString"];

    expect(Object.hasOwn(inputSchema?.properties ?? {}, "toString")).toBe(true);
    expect(propertySchema).toEqual({ type: "string" });
    expect(inputSchema?.required).toEqual(["toString"]);
  });

  it("serializes union schema properties named __proto__ as own keys", () => {
    const protoKey = "__proto__";
    const [entry] = buildMcpToolSchema([
      {
        name: "proof_tool",
        description: "proof",
        parameters: {
          anyOf: [
            {
              type: "object",
              properties: Object.fromEntries([[protoKey, { type: "string" }]]),
              required: [protoKey],
            },
          ],
        },
      } as never,
    ]);

    const inputSchema = entry?.inputSchema as
      | { properties?: Record<string, unknown>; required?: string[] }
      | undefined;

    expect(Object.hasOwn(inputSchema?.properties ?? {}, protoKey)).toBe(true);
    expect(inputSchema?.properties?.[protoKey]).toEqual({ type: "string" });
    expect(JSON.stringify(inputSchema?.properties)).toContain('"__proto__"');
    expect(inputSchema?.required).toEqual([protoKey]);
  });

  it("does not keep inherited prototype names as required schema keys", () => {
    const [entry] = buildMcpToolSchema([
      {
        name: "proof_tool",
        description: "proof",
        parameters: {
          anyOf: [
            {
              type: "object",
              properties: {
                value: { type: "string" },
              },
              required: ["toString"],
            },
          ],
        },
      } as never,
    ]);

    expect(entry?.inputSchema.required).toEqual([]);
  });
});
