import { Type } from "typebox";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { createCapturedPluginRegistration } from "../plugins/captured-registration.js";
import { defineToolPlugin, getToolPluginMetadata } from "./tool-plugin.js";

describe("defineToolPlugin", () => {
  it("registers declared tools and wraps plain object results", async () => {
    const entry = defineToolPlugin({
      id: "stock-quotes",
      name: "Stock Quotes",
      description: "Fetch stock quotes.",
      configSchema: Type.Object({
        apiKey: Type.String(),
      }),
      tools: (tool) => [
        tool({
          name: "quote",
          label: "Quote",
          description: "Fetch a quote.",
          parameters: Type.Object({
            symbol: Type.String(),
          }),
          async execute(params, config) {
            expectTypeOf(params.symbol).toEqualTypeOf<string>();
            expectTypeOf(config.apiKey).toEqualTypeOf<string>();
            return { symbol: params.symbol, configured: config.apiKey === "test-key" };
          },
        }),
      ],
    });
    const captured = createCapturedPluginRegistration({
      config: { plugins: { entries: { "stock-quotes": { config: { apiKey: "test-key" } } } } },
      id: "stock-quotes",
    });
    captured.api.pluginConfig = { apiKey: "test-key" };

    entry.register(captured.api);

    expect(captured.tools).toHaveLength(1);
    expect(captured.tools[0]).toMatchObject({
      name: "quote",
      label: "Quote",
      description: "Fetch a quote.",
    });
    const result = await captured.tools[0].execute("call-1", { symbol: "OPEN" });
    expect(result.details).toEqual({ symbol: "OPEN", configured: true });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ symbol: "OPEN", configured: true }, null, 2) },
    ]);
  });

  it("wraps plain string results", async () => {
    const entry = defineToolPlugin({
      id: "echo",
      name: "Echo",
      description: "Echo input.",
      tools: (tool) => [
        tool({
          name: "echo",
          description: "Echo input.",
          parameters: Type.Object({ input: Type.String() }),
          execute: ({ input }) => input,
        }),
      ],
    });
    const captured = createCapturedPluginRegistration({ id: "echo" });

    entry.register(captured.api);

    const result = await captured.tools[0].execute("call-1", { input: "hello" });
    expect(result).toEqual({
      content: [{ type: "text", text: "hello" }],
      details: "hello",
    });
  });

  it("passes optional tools through to runtime registration and metadata", () => {
    const entry = defineToolPlugin({
      id: "optional-tools",
      name: "Optional Tools",
      description: "Optional tool demo.",
      tools: (tool) => [
        tool({
          name: "optional_echo",
          description: "Echo input.",
          parameters: Type.Object({ input: Type.String() }),
          optional: true,
          execute: ({ input }) => input,
        }),
      ],
    });
    const captured = createCapturedPluginRegistration({ id: "optional-tools" });
    const registerTool = vi.fn();
    captured.api.registerTool = registerTool as typeof captured.api.registerTool;

    entry.register(captured.api);

    expect(registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "optional_echo" }), {
      optional: true,
    });
    expect(getToolPluginMetadata(entry)?.tools).toMatchObject([
      { name: "optional_echo", optional: true },
    ]);
  });

  it("supports context factories while keeping static tool metadata", () => {
    const entry = defineToolPlugin({
      id: "factory-tools",
      name: "Factory Tools",
      description: "Factory tool demo.",
      configSchema: Type.Object({ prefix: Type.String() }),
      tools: (tool) => [
        tool({
          name: "factory_echo",
          label: "Factory Echo",
          description: "Echo input.",
          parameters: Type.Object({ input: Type.String() }),
          optional: true,
          factory({ config, toolContext }) {
            if (toolContext.sandboxed) {
              return null;
            }
            return {
              name: "factory_echo",
              label: "Factory Echo",
              description: "Echo input.",
              parameters: Type.Object({ input: Type.String() }),
              async execute(_toolCallId: string, params: { input?: unknown }) {
                const input = typeof params.input === "string" ? params.input : "";
                return {
                  content: [
                    {
                      type: "text",
                      text: `${config.prefix}:${input}`,
                    },
                  ],
                  details: undefined,
                };
              },
            };
          },
        }),
      ],
    });
    const captured = createCapturedPluginRegistration({ id: "factory-tools" });
    captured.api.pluginConfig = { prefix: "ctx" };
    const registerTool = vi.fn();
    captured.api.registerTool = registerTool as typeof captured.api.registerTool;

    entry.register(captured.api);

    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
      name: "factory_echo",
      optional: true,
    });
    expect(getToolPluginMetadata(entry)?.tools).toMatchObject([
      {
        name: "factory_echo",
        label: "Factory Echo",
        optional: true,
      },
    ]);

    const factory = registerTool.mock.calls[0]?.[0] as (ctx: { sandboxed?: boolean }) => unknown;
    expect(factory({ sandboxed: true })).toBeNull();
    expect(factory({ sandboxed: false })).toMatchObject({ name: "factory_echo" });
  });

  it("defaults author config to a strict empty object schema", () => {
    const entry = defineToolPlugin({
      id: "empty-config",
      name: "Empty Config",
      description: "No config.",
      tools: () => [],
    });

    expect(entry.configSchema.jsonSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
    expect(getToolPluginMetadata(entry)?.configSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
  });

  it("exposes static metadata for manifest generation without running tools", () => {
    const execute = vi.fn();
    const entry = defineToolPlugin({
      id: "metadata-demo",
      name: "Metadata Demo",
      description: "Static metadata.",
      activation: { onCapabilities: ["tool"] },
      tools: (tool) => [
        tool({
          name: "metadata_tool",
          description: "Static tool.",
          parameters: Type.Object({ input: Type.String() }),
          execute,
        }),
      ],
    });

    expect(execute).not.toHaveBeenCalled();
    expect(getToolPluginMetadata(entry)).toMatchObject({
      id: "metadata-demo",
      activation: { onCapabilities: ["tool"] },
      tools: [{ name: "metadata_tool", description: "Static tool." }],
    });
  });
});
