import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { __testing, createClawdbotCodingTools } from "./pi-tools.js";

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

      const wrapped = __testing.wrapToolParamNormalization(tool, [
        { keys: ["path", "file_path"] },
      ]);

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
      await expect(
        wrapped.execute("tool-3", { file_path: "   ", content: "x" }),
      ).rejects.toThrow(/Missing required parameter/);
    });
  });

  it("applies tool profiles before allow/deny policies", () => {
    const tools = createClawdbotCodingTools({
      config: { tools: { profile: "messaging" } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("message")).toBe(true);
    expect(names.has("sessions_send")).toBe(true);
    expect(names.has("sessions_spawn")).toBe(false);
    expect(names.has("exec")).toBe(false);
    expect(names.has("browser")).toBe(false);
  });
  it("expands group shorthands in global tool policy", () => {
    const tools = createClawdbotCodingTools({
      config: { tools: { allow: ["group:fs"] } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("browser")).toBe(false);
  });
  it("expands group shorthands in global tool deny policy", () => {
    const tools = createClawdbotCodingTools({
      config: { tools: { deny: ["group:fs"] } },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("read")).toBe(false);
    expect(names.has("write")).toBe(false);
    expect(names.has("edit")).toBe(false);
    expect(names.has("exec")).toBe(true);
  });
  it("lets agent profiles override global profiles", () => {
    const tools = createClawdbotCodingTools({
      sessionKey: "agent:work:main",
      config: {
        tools: { profile: "coding" },
        agents: {
          list: [{ id: "work", tools: { profile: "messaging" } }],
        },
      },
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("message")).toBe(true);
    expect(names.has("exec")).toBe(false);
    expect(names.has("read")).toBe(false);
  });
  it("removes unsupported JSON Schema keywords for Cloud Code Assist API compatibility", () => {
    const tools = createClawdbotCodingTools();

    // Helper to recursively check schema for unsupported keywords
    const unsupportedKeywords = new Set([
      "patternProperties",
      "additionalProperties",
      "$schema",
      "$id",
      "$ref",
      "$defs",
      "definitions",
      "examples",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "multipleOf",
      "pattern",
      "format",
      "minItems",
      "maxItems",
      "uniqueItems",
      "minProperties",
      "maxProperties",
    ]);

    const findUnsupportedKeywords = (
      schema: unknown,
      path: string,
    ): string[] => {
      const found: string[] = [];
      if (!schema || typeof schema !== "object") return found;
      if (Array.isArray(schema)) {
        schema.forEach((item, i) => {
          found.push(...findUnsupportedKeywords(item, `${path}[${i}]`));
        });
        return found;
      }

      const record = schema as Record<string, unknown>;
      const properties =
        record.properties &&
        typeof record.properties === "object" &&
        !Array.isArray(record.properties)
          ? (record.properties as Record<string, unknown>)
          : undefined;
      if (properties) {
        for (const [key, value] of Object.entries(properties)) {
          found.push(
            ...findUnsupportedKeywords(value, `${path}.properties.${key}`),
          );
        }
      }

      for (const [key, value] of Object.entries(record)) {
        if (key === "properties") continue;
        if (unsupportedKeywords.has(key)) {
          found.push(`${path}.${key}`);
        }
        if (value && typeof value === "object") {
          found.push(...findUnsupportedKeywords(value, `${path}.${key}`));
        }
      }
      return found;
    };

    for (const tool of tools) {
      const violations = findUnsupportedKeywords(
        tool.parameters,
        `${tool.name}.parameters`,
      );
      expect(violations).toEqual([]);
    }
  });
});
