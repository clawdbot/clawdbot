import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { __testing, createClawdbotCodingTools } from "./pi-tools.js";
import { createBrowserTool } from "./tools/browser-tool.js";

describe("createClawdbotCodingTools", () => {
  describe("Claude/Gemini alias support", () => {
    it("adds Claude-style aliases to schemas without dropping metadata", () => {
      const base: AgentTool = {
        name: "write",
        description: "test",
        parameters: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string", description: "Path" },
            content: { type: "string", description: "Body" },
          },
        },
        execute: vi.fn(),
      };

      const patched = __testing.patchToolSchemaForClaudeCompatibility(base);
      const params = patched.parameters as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const props = params.properties ?? {};

      expect(props.file_path).toEqual(props.path);
      expect(params.required ?? []).not.toContain("path");
      expect(params.required ?? []).not.toContain("file_path");
    });

    it("normalizes file_path to path and enforces required groups at runtime", async () => {
      const execute = vi.fn(async (_id, args) => args);
      const tool: AgentTool = {
        name: "write",
        description: "test",
        parameters: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
        },
        execute,
      };

      const wrapped = __testing.wrapToolParamNormalization(tool, [{ keys: ["path", "file_path"] }]);

      await wrapped.execute("tool-1", { file_path: "foo.txt", content: "x" });
      expect(execute).toHaveBeenCalledWith(
        "tool-1",
        { path: "foo.txt", content: "x" },
        undefined,
        undefined,
      );

      await expect(wrapped.execute("tool-2", { content: "x" })).rejects.toThrow(
        /Missing required parameter/,
      );
      await expect(wrapped.execute("tool-3", { file_path: "   ", content: "x" })).rejects.toThrow(
        /Missing required parameter/,
      );
    });
  });

  it("keeps browser tool schema OpenAI-compatible without normalization", () => {
    const browser = createBrowserTool();
    const schema = browser.parameters as { type?: unknown; anyOf?: unknown };
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();
  });
  it("mentions Chrome extension relay in browser tool description", () => {
    const browser = createBrowserTool();
    expect(browser.description).toMatch(/Chrome extension/i);
    expect(browser.description).toMatch(/profile="chrome"/i);
  });
  it("keeps browser tool schema properties after normalization", () => {
    const tools = createClawdbotCodingTools();
    const browser = tools.find((tool) => tool.name === "browser");
    expect(browser).toBeDefined();
    const parameters = browser?.parameters as {
      anyOf?: unknown[];
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(parameters.properties?.action).toBeDefined();
    expect(parameters.properties?.target).toBeDefined();
    expect(parameters.properties?.controlUrl).toBeDefined();
    expect(parameters.properties?.targetUrl).toBeDefined();
    expect(parameters.properties?.request).toBeDefined();
    expect(parameters.required ?? []).toContain("action");
  });
  it("exposes raw for gateway config.apply tool calls", () => {
    const tools = createClawdbotCodingTools();
    const gateway = tools.find((tool) => tool.name === "gateway");
    expect(gateway).toBeDefined();

    const parameters = gateway?.parameters as {
      type?: unknown;
      required?: string[];
      properties?: Record<string, unknown>;
    };
    expect(parameters.type).toBe("object");
    expect(parameters.properties?.raw).toBeDefined();
    expect(parameters.required ?? []).not.toContain("raw");
  });
  it("flattens anyOf-of-literals to enum for provider compatibility", () => {
    const tools = createClawdbotCodingTools();
    const browser = tools.find((tool) => tool.name === "browser");
    expect(browser).toBeDefined();

    const parameters = browser?.parameters as {
      properties?: Record<string, unknown>;
    };
    const action = parameters.properties?.action as
      | {
          type?: unknown;
          enum?: unknown[];
          anyOf?: unknown[];
        }
      | undefined;

    expect(action?.type).toBe("string");
    expect(action?.anyOf).toBeUndefined();
    expect(Array.isArray(action?.enum)).toBe(true);
    expect(action?.enum).toContain("act");

    const format = parameters.properties?.format as
      | {
          type?: unknown;
          enum?: unknown[];
          anyOf?: unknown[];
        }
      | undefined;
    expect(format?.type).toBe("string");
    expect(format?.anyOf).toBeUndefined();
    expect(format?.enum).toEqual(["aria", "ai"]);
  });
  it("inlines local $ref before removing unsupported keywords", () => {
    const cleaned = __testing.cleanToolSchemaForGemini({
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/Foo" },
      },
      $defs: {
        Foo: { type: "string", enum: ["a", "b"] },
      },
    }) as {
      $defs?: unknown;
      properties?: Record<string, unknown>;
    };

    expect(cleaned.$defs).toBeUndefined();
    expect(cleaned.properties).toBeDefined();
    expect(cleaned.properties?.foo).toMatchObject({
      type: "string",
      enum: ["a", "b"],
    });
  });
  it("cleans tuple items schemas", () => {
    const cleaned = __testing.cleanToolSchemaForGemini({
      type: "object",
      properties: {
        tuples: {
          type: "array",
          items: [
            { type: "string", format: "uuid" },
            { type: "number", minimum: 1 },
          ],
        },
      },
    }) as {
      properties?: Record<string, unknown>;
    };

    const tuples = cleaned.properties?.tuples as { items?: unknown } | undefined;
    const items = Array.isArray(tuples?.items) ? tuples?.items : [];
    const first = items[0] as { format?: unknown } | undefined;
    const second = items[1] as { minimum?: unknown } | undefined;

    expect(first?.format).toBeUndefined();
    expect(second?.minimum).toBeUndefined();
  });
  it("drops null-only union variants without flattening other unions", () => {
    const cleaned = __testing.cleanToolSchemaForGemini({
      type: "object",
      properties: {
        parentId: { anyOf: [{ type: "string" }, { type: "null" }] },
        count: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
    }) as {
      properties?: Record<string, unknown>;
    };

    const parentId = cleaned.properties?.parentId as
      | { type?: unknown; anyOf?: unknown; oneOf?: unknown }
      | undefined;
    expect(parentId?.anyOf).toBeUndefined();
    expect(parentId?.oneOf).toBeUndefined();
    expect(parentId?.type).toBe("string");

    const count = cleaned.properties?.count as
      | { type?: unknown; anyOf?: unknown; oneOf?: unknown }
      | undefined;
    expect(count?.anyOf).toBeUndefined();
    expect(Array.isArray(count?.oneOf)).toBe(true);
  });
});
