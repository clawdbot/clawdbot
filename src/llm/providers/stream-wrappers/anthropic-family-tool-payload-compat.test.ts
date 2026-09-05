import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createOpenAIAnthropicToolPayloadCompatibilityWrapper } from "./anthropic-family-tool-payload-compat.js";

const model = {
  api: "anthropic-messages",
  provider: "openai-compatible-anthropic",
  id: "claude-compatible",
  compat: { requiresOpenAiAnthropicToolPayload: true },
} as unknown as Model<"anthropic-messages">;

function runWrapper(payload: Record<string, unknown>, nextModel = model) {
  const payloads: Array<Record<string, unknown>> = [];
  const baseStreamFn: StreamFn = (streamModel, context, options) => {
    options?.onPayload?.(payload, streamModel);
    payloads.push(structuredClone(payload));
    return createAssistantMessageEventStream();
  };
  const wrapped = createOpenAIAnthropicToolPayloadCompatibilityWrapper(baseStreamFn);
  void wrapped(nextModel, { messages: [] }, {});
  return payloads[0];
}

describe("createOpenAIAnthropicToolPayloadCompatibilityWrapper", () => {
  it("disables GPT-5.6 reasoning when projecting function tools", () => {
    const payload = runWrapper(
      {
        reasoning_effort: "low",
        tools: [
          {
            name: "lookup",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      { ...model, id: "gpt-5.6-luna" },
    );

    expect(payload?.reasoning_effort).toBe("none");
  });

  it("skips unreadable schemas while preserving a healthy pinned tool", () => {
    const payload = runWrapper({
      tools: [
        {
          name: "bad_schema",
          get parameters(): never {
            throw new Error("parameters getter exploded");
          },
        },
        {
          name: "lookup",
          description: "Lookup",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
      tool_choice: { type: "tool", name: "lookup" },
    });

    expect(payload?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      },
    ]);
    expect(payload?.tool_choice).toEqual({
      type: "function",
      function: { name: "lookup" },
    });
  });

  it("uses input_schema without reading a poisoned parameters fallback", () => {
    const payload = runWrapper({
      tools: [
        {
          name: "lookup",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
          get parameters(): never {
            throw new Error("parameters fallback getter exploded");
          },
        },
      ],
    });

    expect(payload?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      },
    ]);
  });

  it("skips unreadable and structurally invalid schemas while preserving healthy siblings", () => {
    const circularSchema: Record<string, unknown> = {
      type: "object",
      properties: {},
    };
    circularSchema.self = circularSchema;
    const payload = runWrapper({
      tools: [
        {
          name: "circular_schema",
          parameters: circularSchema,
        },
        {
          type: "function",
          function: {
            name: "nested_getter",
            parameters: {
              type: "object",
              properties: {
                get value(): never {
                  throw new Error("nested schema getter exploded");
                },
              },
            },
          },
        },
        {
          name: "invalid_properties",
          parameters: {
            type: "object",
            properties: false,
          },
        },
        {
          name: "invalid_required",
          parameters: {
            type: "object",
            required: "query",
          },
        },
        {
          name: "invalid_root",
          input_schema: [],
        },
        {
          name: "lookup",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ],
    });

    expect(payload?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      },
    ]);
  });

  it("preserves JSON-serializable dynamic schema references", () => {
    const payload = runWrapper({
      tools: [
        {
          name: "lookup",
          input_schema: {
            type: "object",
            properties: {
              query: { $dynamicRef: "#query" },
            },
          },
        },
      ],
    });

    expect(payload?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: {
            type: "object",
            properties: {
              query: { $dynamicRef: "#query" },
            },
          },
        },
      },
    ]);
  });

  it("normalizes null object schema keywords", () => {
    const payload = runWrapper({
      tools: [
        {
          name: "lookup",
          parameters: {
            type: "object",
            properties: null,
            required: null,
          },
        },
      ],
    });

    expect(payload?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: {
            type: "object",
          },
        },
      },
    ]);
  });

  it("preserves provider metadata on existing OpenAI function tools", () => {
    const payload = runWrapper({
      tools: [
        {
          type: "function",
          cache_control: { type: "ephemeral" },
          function: {
            name: "lookup",
            parameters: { type: "object", properties: {} },
            get description(): never {
              throw new Error("description getter exploded");
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "lookup" },
      },
    });

    expect(payload).toEqual({
      tools: [
        {
          type: "function",
          cache_control: { type: "ephemeral" },
          function: {
            name: "lookup",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "lookup" },
      },
    });
  });

  it("projects custom tools and named custom choices as OpenAI functions", () => {
    const payload = runWrapper({
      tools: [
        {
          type: "custom",
          custom: {
            name: "shell",
            description: "Run a shell command.",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        },
      ],
      tool_choice: {
        type: "custom",
        custom: { name: "shell" },
      },
    });

    expect(payload).toEqual({
      tools: [
        {
          type: "function",
          function: {
            name: "shell",
            description: "Run a shell command.",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "shell" },
      },
    });
  });

  it("preserves free-form custom tools and named custom choices", () => {
    const payload = runWrapper({
      tools: [
        {
          type: "custom",
          custom: {
            name: "shell",
            description: "Run a shell command.",
            format: { type: "text" },
          },
        },
      ],
      tool_choice: {
        type: "custom",
        custom: { name: "shell" },
      },
    });

    expect(payload).toEqual({
      tools: [
        {
          type: "custom",
          custom: {
            name: "shell",
            description: "Run a shell command.",
            format: { type: "text" },
          },
        },
      ],
      tool_choice: {
        type: "custom",
        custom: { name: "shell" },
      },
    });
  });

  it("projects allowed custom tool choices against surviving functions", () => {
    const payload = runWrapper({
      tools: [
        {
          name: "broken",
          get parameters(): never {
            throw new Error("parameters getter exploded");
          },
        },
        {
          type: "custom",
          custom: {
            name: "shell",
            input_schema: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: {
        type: "allowed_tools",
        allowed_tools: {
          mode: "required",
          tools: [
            { type: "function", function: { name: "broken" } },
            { type: "custom", custom: { name: "shell" } },
          ],
        },
      },
    });

    expect(payload?.tool_choice).toEqual({
      type: "allowed_tools",
      allowed_tools: {
        mode: "required",
        tools: [{ type: "function", function: { name: "shell" } }],
      },
    });
  });

  it("does not match allowed tools across tool kinds", () => {
    const payload = runWrapper({
      tools: [
        {
          type: "custom",
          custom: {
            name: "shell",
            input_schema: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: {
        type: "allowed_tools",
        allowed_tools: {
          mode: "auto",
          tools: [{ type: "function", function: { name: "shell" } }],
        },
      },
    });

    expect(payload?.tool_choice).toBe("none");
  });

  it("disables tool calls when no auto-allowed tools survive", () => {
    const payload = runWrapper({
      tools: [
        {
          name: "broken",
          get parameters(): never {
            throw new Error("parameters getter exploded");
          },
        },
        {
          type: "custom",
          custom: { name: "shell" },
        },
      ],
      tool_choice: {
        type: "allowed_tools",
        allowed_tools: {
          mode: "auto",
          tools: [{ type: "function", function: { name: "broken" } }],
        },
      },
    });

    expect(payload?.tool_choice).toBe("none");
  });

  it("keeps a usable schema when optional metadata getters throw", () => {
    const payload = runWrapper({
      tools: [
        {
          name: "lookup",
          parameters: { type: "object", properties: {} },
          get description(): never {
            throw new Error("description getter exploded");
          },
          get strict(): never {
            throw new Error("strict getter exploded");
          },
        },
      ],
    });

    expect(payload?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  it("rejects a pinned choice when its tool is unreadable", () => {
    expect(() =>
      runWrapper({
        tools: [
          {
            name: "bad_schema",
            get parameters(): never {
              throw new Error("parameters getter exploded");
            },
          },
          {
            name: "lookup",
            parameters: { type: "object", properties: {} },
          },
        ],
        tool_choice: { type: "tool", name: "bad_schema" },
      }),
    ).toThrow('requested unavailable tool "bad_schema"');
  });

  it("rejects required choice when every tool is unreadable", () => {
    expect(() =>
      runWrapper({
        tools: [
          {
            name: "bad_schema",
            get parameters(): never {
              throw new Error("parameters getter exploded");
            },
          },
        ],
        tool_choice: { type: "any" },
      }),
    ).toThrow("requires a tool, but no tools survived");
  });

  it("rejects an already-normalized required choice when every tool is unreadable", () => {
    expect(() =>
      runWrapper({
        tools: [
          {
            name: "bad_schema",
            get parameters(): never {
              throw new Error("parameters getter exploded");
            },
          },
        ],
        tool_choice: "required",
      }),
    ).toThrow("requires a tool, but no tools survived");
  });

  it("rejects required allowed tools when none survive conversion", () => {
    expect(() =>
      runWrapper({
        tools: [
          {
            name: "broken",
            get parameters(): never {
              throw new Error("parameters getter exploded");
            },
          },
        ],
        tool_choice: {
          type: "allowed_tools",
          allowed_tools: {
            mode: "required",
            tools: [{ type: "function", function: { name: "broken" } }],
          },
        },
      }),
    ).toThrow("no allowed tools survived");
  });

  it("omits auto choice and tools when every tool is unreadable", () => {
    const payload = runWrapper({
      tools: [
        {
          name: "bad_schema",
          get parameters(): never {
            throw new Error("parameters getter exploded");
          },
        },
      ],
      tool_choice: { type: "auto" },
    });

    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("tool_choice");
  });

  it("omits an already-normalized auto choice when every tool is unreadable", () => {
    const payload = runWrapper({
      tools: [
        {
          name: "bad_schema",
          get parameters(): never {
            throw new Error("parameters getter exploded");
          },
        },
      ],
      tool_choice: "auto",
    });

    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("tool_choice");
  });
});
