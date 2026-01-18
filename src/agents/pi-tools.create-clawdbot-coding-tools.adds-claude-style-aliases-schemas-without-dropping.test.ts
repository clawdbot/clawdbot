import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createClawdbotTools } from "./clawdbot-tools.js";
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

  it("avoids anyOf/oneOf/allOf in tool schemas", () => {
    const tools = createClawdbotCodingTools();
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
});
