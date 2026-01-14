import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../config/config.js";
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

  it("preserves action enums in normalized schemas", () => {
    const tools = createClawdbotCodingTools();
    const toolNames = [
      "browser",
      "canvas",
      "nodes",
      "cron",
      "gateway",
      "message",
    ];

    const collectActionValues = (
      schema: unknown,
      values: Set<string>,
    ): void => {
      if (!schema || typeof schema !== "object") return;
      const record = schema as Record<string, unknown>;
      if (typeof record.const === "string") values.add(record.const);
      if (Array.isArray(record.enum)) {
        for (const value of record.enum) {
          if (typeof value === "string") values.add(value);
        }
      }
      if (Array.isArray(record.anyOf)) {
        for (const variant of record.anyOf) {
          collectActionValues(variant, values);
        }
      }
    };

    for (const name of toolNames) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      const parameters = tool?.parameters as {
        properties?: Record<string, unknown>;
      };
      const action = parameters.properties?.action as
        | { const?: unknown; enum?: unknown[] }
        | undefined;
      const values = new Set<string>();
      collectActionValues(action, values);

      const min =
        name === "gateway"
          ? 1
          : // Most tools expose multiple actions; keep this signal so schemas stay useful to models.
            2;
      expect(values.size).toBeGreaterThanOrEqual(min);
    }
  });
  it("includes exec and process tools by default", () => {
    const tools = createClawdbotCodingTools();
    expect(tools.some((tool) => tool.name === "exec")).toBe(true);
    expect(tools.some((tool) => tool.name === "process")).toBe(true);
    expect(tools.some((tool) => tool.name === "apply_patch")).toBe(false);
  });
  it("gates apply_patch behind tools.exec.applyPatch for OpenAI models", () => {
    const config: ClawdbotConfig = {
      tools: {
        exec: {
          applyPatch: { enabled: true },
        },
      },
    };
    const openAiTools = createClawdbotCodingTools({
      config,
      modelProvider: "openai",
      modelId: "gpt-5.2",
    });
    expect(openAiTools.some((tool) => tool.name === "apply_patch")).toBe(true);

    const anthropicTools = createClawdbotCodingTools({
      config,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-5",
    });
    expect(anthropicTools.some((tool) => tool.name === "apply_patch")).toBe(
      false,
    );
  });
  it("respects apply_patch allowModels", () => {
    const config: ClawdbotConfig = {
      tools: {
        exec: {
          applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
        },
      },
    };
    const allowed = createClawdbotCodingTools({
      config,
      modelProvider: "openai",
      modelId: "gpt-5.2",
    });
    expect(allowed.some((tool) => tool.name === "apply_patch")).toBe(true);

    const denied = createClawdbotCodingTools({
      config,
      modelProvider: "openai",
      modelId: "gpt-5-mini",
    });
    expect(denied.some((tool) => tool.name === "apply_patch")).toBe(false);
  });
  it("keeps canonical tool names for Anthropic OAuth (pi-ai remaps on the wire)", () => {
    const tools = createClawdbotCodingTools({
      modelProvider: "anthropic",
      modelAuthMode: "oauth",
    });
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has("exec")).toBe(true);
    expect(names.has("read")).toBe(true);
    expect(names.has("write")).toBe(true);
    expect(names.has("edit")).toBe(true);
    expect(names.has("apply_patch")).toBe(false);
  });
  it("provides top-level object schemas for all tools", () => {
    const tools = createClawdbotCodingTools();
    const offenders = tools
      .map((tool) => {
        const schema =
          tool.parameters && typeof tool.parameters === "object"
            ? (tool.parameters as Record<string, unknown>)
            : null;
        return {
          name: tool.name,
          type: schema?.type,
          keys: schema ? Object.keys(schema).sort() : null,
        };
      })
      .filter((entry) => entry.type !== "object");

    expect(offenders).toEqual([]);
  });
});
