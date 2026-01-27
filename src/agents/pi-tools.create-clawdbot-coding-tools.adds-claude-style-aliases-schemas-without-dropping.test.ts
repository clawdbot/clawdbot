import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import { createClawdbotTools } from "./clawdbot-tools.js";
import { __testing, createClawdbotCodingTools } from "./pi-tools.js";
import { createSandboxedReadTool } from "./pi-tools.read.js";
import { createBrowserTool } from "./tools/browser-tool.js";

const defaultTools = createClawdbotCodingTools();

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
    const browser = defaultTools.find((tool) => tool.name === "browser");
    expect(browser).toBeDefined();
    const parameters = browser?.parameters as {
      anyOf?: unknown[];
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(parameters.properties?.action).toBeDefined();
    expect(parameters.properties?.target).toBeDefined();
    expect(parameters.properties?.targetUrl).toBeDefined();
    expect(parameters.properties?.request).toBeDefined();
    expect(parameters.required ?? []).toContain("action");
  });
  it("exposes raw for gateway config.apply tool calls", () => {
    const gateway = defaultTools.find((tool) => tool.name === "gateway");
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
    const browser = defaultTools.find((tool) => tool.name === "browser");
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

    const snapshotFormat = parameters.properties?.snapshotFormat as
      | {
          type?: unknown;
          enum?: unknown[];
          anyOf?: unknown[];
        }
      | undefined;
    expect(snapshotFormat?.type).toBe("string");
    expect(snapshotFormat?.anyOf).toBeUndefined();
    expect(snapshotFormat?.enum).toEqual(["aria", "ai"]);
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
    const count = cleaned.properties?.count as
      | { type?: unknown; anyOf?: unknown; oneOf?: unknown }
      | undefined;

    expect(parentId?.type).toBe("string");
    expect(parentId?.anyOf).toBeUndefined();
    expect(count?.oneOf).toBeDefined();
  });
  it("avoids anyOf/oneOf/allOf in tool schemas", () => {
    const offenders: Array<{
      name: string;
      keyword: string;
      path: string;
    }> = [];
    const keywords = new Set(["anyOf", "oneOf", "allOf"]);

    const walk = (value: unknown, path: string, name: string): void => {
      if (!value) return;
      if (Array.isArray(value)) {
        for (const [index, entry] of value.entries()) {
          walk(entry, `${path}[${index}]`, name);
        }
        return;
      }
      if (typeof value !== "object") return;

      const record = value as Record<string, unknown>;
      for (const [key, entry] of Object.entries(record)) {
        const nextPath = path ? `${path}.${key}` : key;
        if (keywords.has(key)) {
          offenders.push({ name, keyword: key, path: nextPath });
        }
        walk(entry, nextPath, name);
      }
    };

    for (const tool of defaultTools) {
      walk(tool.parameters, "", tool.name);
    }

    expect(offenders).toEqual([]);
  });
  it("keeps raw core tool schemas union-free", () => {
    const tools = createClawdbotTools();
    const coreTools = new Set([
      "browser",
      "canvas",
      "nodes",
      "cron",
      "message",
      "gateway",
      "agents_list",
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "sessions_spawn",
      "session_status",
      "image",
    ]);
    const offenders: Array<{
      name: string;
      keyword: string;
      path: string;
    }> = [];
    const keywords = new Set(["anyOf", "oneOf", "allOf"]);

    const walk = (value: unknown, path: string, name: string): void => {
      if (!value) return;
      if (Array.isArray(value)) {
        for (const [index, entry] of value.entries()) {
          walk(entry, `${path}[${index}]`, name);
        }
        return;
      }
      if (typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      for (const [key, entry] of Object.entries(record)) {
        const nextPath = path ? `${path}.${key}` : key;
        if (keywords.has(key)) {
          offenders.push({ name, keyword: key, path: nextPath });
        }
        walk(entry, nextPath, name);
      }
    };

    for (const tool of tools) {
      if (!coreTools.has(tool.name)) continue;
      walk(tool.parameters, "", tool.name);
    }

    expect(offenders).toEqual([]);
  });
  it("does not expose provider-specific message tools", () => {
    const tools = createClawdbotCodingTools({ messageProvider: "discord" });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("discord")).toBe(false);
    expect(names.has("slack")).toBe(false);
    expect(names.has("telegram")).toBe(false);
    expect(names.has("whatsapp")).toBe(false);
  });
  it("filters session tools for sub-agent sessions by default", () => {
    const tools = createClawdbotCodingTools({
      sessionKey: "agent:main:subagent:test",
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("sessions_list")).toBe(false);
    expect(names.has("sessions_history")).toBe(false);
    expect(names.has("sessions_send")).toBe(false);
    expect(names.has("sessions_spawn")).toBe(false);

    expect(names.has("read")).toBe(true);
    expect(names.has("exec")).toBe(true);
    expect(names.has("process")).toBe(true);
    expect(names.has("apply_patch")).toBe(false);
  });
  it("supports allow-only sub-agent tool policy", () => {
    const tools = createClawdbotCodingTools({
      sessionKey: "agent:main:subagent:test",
      // Intentionally partial config; only fields used by pi-tools are provided.
      config: {
        tools: {
          subagents: {
            tools: {
              // Policy matching is case-insensitive
              allow: ["read"],
            },
          },
        },
      },
    });
    expect(tools.map((tool) => tool.name)).toEqual(["read"]);
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

    const findUnsupportedKeywords = (schema: unknown, path: string): string[] => {
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
          found.push(...findUnsupportedKeywords(value, `${path}.properties.${key}`));
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

    for (const tool of defaultTools) {
      const violations = findUnsupportedKeywords(tool.parameters, `${tool.name}.parameters`);
      expect(violations).toEqual([]);
    }
  });
  it("applies sandbox path guards to file_path alias", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-sbx-"));
    const outsidePath = path.join(os.tmpdir(), "clawdbot-outside.txt");
    await fs.writeFile(outsidePath, "outside", "utf8");
    try {
      const readTool = createSandboxedReadTool(tmpDir);
      await expect(readTool.execute("sandbox-1", { file_path: outsidePath })).rejects.toThrow(
        /sandbox root/i,
      );
    } finally {
      await fs.rm(outsidePath, { force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
