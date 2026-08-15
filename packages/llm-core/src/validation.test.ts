// LLM Core tests cover validation behavior.
import { describe, expect, it } from "vitest";
import type { Tool } from "./types.js";
import { validateToolArguments } from "./validation.js";

const decimalTool = {
  name: "decimal-tool",
  description: "test tool",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number" },
      count: { type: "integer" },
    },
    required: ["amount", "count"],
    additionalProperties: false,
  },
} as Tool;

describe("validateToolArguments", () => {
  it("coerces strict decimal numeric strings for plain JSON schemas", () => {
    expect(
      validateToolArguments(decimalTool, {
        type: "toolCall",
        id: "call-1",
        name: "decimal-tool",
        arguments: { amount: "1e3", count: "+3" },
      }),
    ).toEqual({ amount: 1000, count: 3 });
  });

  it("rejects non-decimal numeric strings for plain JSON schemas", () => {
    expect(() =>
      validateToolArguments(decimalTool, {
        type: "toolCall",
        id: "call-1",
        name: "decimal-tool",
        arguments: { amount: "0x10", count: "0b10" },
      }),
    ).toThrow(/Validation failed for tool "decimal-tool"/);
  });

  it("preserves null in anyOf [{type: string}, {type: null}] without coercing to empty string (#96716)", () => {
    const tool = {
      name: "nullable-tool",
      description: "test tool",
      parameters: {
        type: "object",
        properties: {
          insight_id: { anyOf: [{ type: "string" }, { type: "null" }] },
          cluster_name: { type: "string" },
        },
        required: ["cluster_name"],
        additionalProperties: false,
      },
    } as Tool;

    expect(
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-1",
        name: "nullable-tool",
        arguments: { insight_id: null, cluster_name: "testenv" },
      }),
    ).toEqual({ insight_id: null, cluster_name: "testenv" });
  });
});

const arrayTool = {
  name: "array-tool",
  description: "test tool with array param",
  parameters: {
    type: "object",
    properties: {
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["tags"],
    additionalProperties: false,
  },
} as Tool;

const objectTool = {
  name: "object-tool",
  description: "test tool with object param",
  parameters: {
    type: "object",
    properties: {
      config: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          retries: { type: "number" },
        },
      },
    },
    required: ["config"],
    additionalProperties: false,
  },
} as Tool;

describe("validateToolArguments — stringified JSON coercion", () => {
  it("coerces stringified JSON array to array for plain JSON schemas", () => {
    expect(
      validateToolArguments(arrayTool, {
        type: "toolCall",
        id: "call-2",
        name: "array-tool",
        arguments: { tags: '["test","debug"]' },
      }),
    ).toEqual({ tags: ["test", "debug"] });
  });

  it("coerces stringified JSON object to object for plain JSON schemas", () => {
    expect(
      validateToolArguments(objectTool, {
        type: "toolCall",
        id: "call-3",
        name: "object-tool",
        arguments: { config: '{"enabled":true,"retries":3}' },
      }),
    ).toEqual({ config: { enabled: true, retries: 3 } });
  });

  it("passes through valid arrays unchanged", () => {
    expect(
      validateToolArguments(arrayTool, {
        type: "toolCall",
        id: "call-4",
        name: "array-tool",
        arguments: { tags: ["already", "array"] },
      }),
    ).toEqual({ tags: ["already", "array"] });
  });

  it("passes through valid objects unchanged", () => {
    expect(
      validateToolArguments(objectTool, {
        type: "toolCall",
        id: "call-5",
        name: "object-tool",
        arguments: { config: { enabled: false, retries: 1 } },
      }),
    ).toEqual({ config: { enabled: false, retries: 1 } });
  });

  it("rejects invalid JSON string for array param", () => {
    expect(() =>
      validateToolArguments(arrayTool, {
        type: "toolCall",
        id: "call-6",
        name: "array-tool",
        arguments: { tags: "not-json" },
      }),
    ).toThrow(/Validation failed for tool "array-tool"/);
  });

  it("rejects JSON string that is wrong type for array param", () => {
    expect(() =>
      validateToolArguments(arrayTool, {
        type: "toolCall",
        id: "call-7",
        name: "array-tool",
        arguments: { tags: '{"not":"array"}' },
      }),
    ).toThrow(/Validation failed for tool "array-tool"/);
  });

  it("skips JSON coercion for oversized array string", () => {
    const hugeArray = JSON.stringify(Array.from({ length: 100_000 }, (_, i) => i));
    expect(hugeArray.length).toBeGreaterThan(64 * 1024);
    expect(() =>
      validateToolArguments(arrayTool, {
        type: "toolCall",
        id: "call-8",
        name: "array-tool",
        arguments: { tags: hugeArray },
      }),
    ).toThrow(/Validation failed for tool "array-tool"/);
  });

  it("skips JSON coercion for oversized object string", () => {
    const hugeObj = JSON.stringify({ data: "x".repeat(70_000) });
    expect(hugeObj.length).toBeGreaterThan(64 * 1024);
    expect(() =>
      validateToolArguments(objectTool, {
        type: "toolCall",
        id: "call-9",
        name: "object-tool",
        arguments: { config: hugeObj },
      }),
    ).toThrow(/Validation failed for tool "object-tool"/);
  });
});
