import { describe, expect, it } from "vitest";
import type { MoltbotConfig } from "../config/config.js";
import "./test-helpers/fast-coding-tools.js";
import { createMoltbotCodingTools } from "./pi-tools.js";

const defaultTools = createMoltbotCodingTools();

describe("createMoltbotCodingTools", () => {
  it("preserves action enums in normalized schemas", () => {
    const toolNames = ["browser", "canvas", "nodes", "cron", "gateway", "message"];

    const collectActionValues = (schema: unknown, values: Set<string>): void => {
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
      const tool = defaultTools.find((candidate) => candidate.name === name);
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
    expect(defaultTools.some((tool) => tool.name === "exec")).toBe(true);
    expect(defaultTools.some((tool) => tool.name === "process")).toBe(true);
    expect(defaultTools.some((tool) => tool.name === "apply_patch")).toBe(false);
  });
  it("gates apply_patch behind tools.exec.applyPatch for OpenAI models", () => {
    const config: MoltbotConfig = {
      tools: {
        exec: {
          applyPatch: { enabled: true },
        },
      },
    };
    const openAiTools = createMoltbotCodingTools({
      config,
      modelProvider: "openai",
      modelId: "gpt-5.2",
    });
    expect(openAiTools.some((tool) => tool.name === "apply_patch")).toBe(true);

    const anthropicTools = createMoltbotCodingTools({
      config,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-5",
    });
    expect(anthropicTools.some((tool) => tool.name === "apply_patch")).toBe(false);
  });
  it("respects apply_patch allowModels", () => {
    const config: MoltbotConfig = {
      tools: {
        exec: {
          applyPatch: { enabled: true, allowModels: ["gpt-5.2"] },
        },
      },
    };
    const allowed = createMoltbotCodingTools({
      config,
      modelProvider: "openai",
      modelId: "gpt-5.2",
    });
    expect(allowed.some((tool) => tool.name === "apply_patch")).toBe(true);

    const denied = createMoltbotCodingTools({
      config,
      modelProvider: "openai",
      modelId: "gpt-5-mini",
    });
    expect(denied.some((tool) => tool.name === "apply_patch")).toBe(false);
  });
  it("keeps canonical tool names for Anthropic OAuth (pi-ai remaps on the wire)", () => {
    const tools = createMoltbotCodingTools({
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
    const tools = createMoltbotCodingTools();
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
