import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

function toolCallMessage(
  name: string,
  argumentsValue: Record<string, unknown> = { query: "OpenClaw" },
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "opencode",
    model: "gpt-5.6-sol",
    content: [{ type: "toolCall", id: "call_1", name, arguments: argumentsValue }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

describe("OpenCode stream adapter", () => {
  it("aliases the reserved web_search function across OpenCode Responses requests", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const existingAlias = "openclaw_web_search";
    const wireAlias = "openclaw_web_search_2";
    const baseStreamFn: StreamFn = async (model, _context, options) => {
      const initialPayload = { model: model.id };
      const replacement = await options?.onPayload?.(initialPayload, model);
      capturedPayload = (replacement ?? initialPayload) as Record<string, unknown>;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: {
            type: "toolCall",
            id: "call_1",
            name: wireAlias,
            arguments: { query: "OpenClaw" },
          },
          partial: toolCallMessage(existingAlias),
        });
        stream.push({
          type: "done",
          reason: "toolUse",
          message: toolCallMessage(wireAlias),
        });
      });
      return stream;
    };
    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      providerId: "opencode",
      modelId: "gpt-5.6-sol",
    } as never);
    if (!streamFn) {
      throw new Error("expected OpenCode stream wrapper");
    }

    const stream = await streamFn(
      { provider: "opencode", id: "gpt-5.6-sol", api: "openai-responses" } as never,
      { messages: [] } as never,
      {
        onPayload: () => ({
          tools: [
            { type: "function", name: "web_search" },
            { type: "function", name: existingAlias },
            { type: "function", name: "read" },
          ],
          input: [{ type: "function_call", name: "web_search", call_id: "call_0" }],
          tool_choice: { type: "function", name: "web_search" },
        }),
      },
    );
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(capturedPayload).toEqual({
      tools: [
        { type: "function", name: wireAlias },
        { type: "function", name: existingAlias },
        { type: "function", name: "read" },
      ],
      input: [{ type: "function_call", name: wireAlias, call_id: "call_0" }],
      tool_choice: { type: "function", name: wireAlias },
    });
    expect(events[0]).toMatchObject({
      type: "toolcall_end",
      toolCall: { name: "web_search" },
      partial: { content: [{ name: existingAlias }] },
    });
    expect(events[1]).toMatchObject({
      type: "done",
      message: { content: [{ name: "web_search" }] },
    });
    await expect(stream.result()).resolves.toMatchObject({
      content: [{ name: "web_search" }],
    });
  });

  it("does not restore an unaliased OpenCode Responses function name", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const existingAlias = "openclaw_web_search";
    const source = createAssistantMessageEventStream();
    const payload = { tools: [{ type: "function", name: existingAlias }] };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      void options?.onPayload?.(payload, model);
      queueMicrotask(() => source.end(toolCallMessage(existingAlias)));
      return source;
    };
    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      providerId: "opencode",
      modelId: "gpt-5.6-sol",
    } as never);

    const stream = await streamFn?.(
      { provider: "opencode", id: "gpt-5.6-sol", api: "openai-responses" } as never,
      { messages: [] } as never,
      {},
    );

    expect(payload.tools[0]?.name).toBe(existingAlias);
    await expect(stream?.result()).resolves.toMatchObject({ content: [{ name: existingAlias }] });
  });

  it("round-trips dynamic record tool arguments through OpenCode-compatible schemas", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = async (model, _context, options) => {
      const initialPayload = { model: model.id };
      const replacement = await options?.onPayload?.(initialPayload, model);
      capturedPayload = (replacement ?? initialPayload) as Record<string, unknown>;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const execMessage = toolCallMessage("exec", {
          command: "node app.js",
          env: [{ key: "NODE_ENV", value: "test" }],
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: execMessage.content[0] as never,
          partial: execMessage,
        });
        const duplicateMessage = toolCallMessage("dashboard", {
          props: [
            { key: "title", value: '"first"' },
            { key: "title", value: '"second"' },
          ],
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: duplicateMessage.content[0] as never,
          partial: duplicateMessage,
        });
        const malformedMessage = toolCallMessage("video_generate", {
          providerOptions: [{ key: "broken", value: "not-json" }],
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: malformedMessage.content[0] as never,
          partial: malformedMessage,
        });
        stream.push({
          type: "done",
          reason: "toolUse",
          message: toolCallMessage("video_generate", {
            providerOptions: [
              { key: "label", value: '"42"' },
              { key: "seed", value: "42" },
              { key: "enabled", value: "true" },
              { key: "empty", value: "null" },
            ],
          }),
        });
      });
      return stream;
    };
    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      providerId: "opencode",
      modelId: "gpt-5.6-sol",
    } as never);
    if (!streamFn) {
      throw new Error("expected OpenCode stream wrapper");
    }

    const stream = await streamFn(
      { provider: "opencode", id: "gpt-5.6-sol", api: "openai-responses" } as never,
      { messages: [] } as never,
      {
        onPayload: () => ({
          tools: [
            {
              type: "function",
              name: "exec",
              parameters: {
                type: "object",
                properties: {
                  env: {
                    type: "object",
                    patternProperties: { "^.*$": { type: "string" } },
                  },
                },
              },
            },
            {
              type: "function",
              name: "video_generate",
              parameters: {
                type: "object",
                properties: {
                  providerOptions: {
                    type: "object",
                    patternProperties: { "^.*$": {} },
                  },
                },
              },
            },
            {
              type: "function",
              name: "dashboard",
              parameters: {
                type: "object",
                properties: {
                  props: {
                    type: "object",
                    patternProperties: { "^.*$": {} },
                  },
                },
              },
            },
          ],
          input: [
            {
              type: "function_call",
              name: "exec",
              arguments: JSON.stringify({ command: "node app.js", env: { NODE_ENV: "test" } }),
            },
            {
              type: "function_call",
              name: "video_generate",
              arguments: {
                providerOptions: { label: "42", seed: 42, enabled: true, empty: null },
              },
            },
          ],
        }),
      },
    );
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    const tools = capturedPayload?.tools as Array<Record<string, unknown>>;
    const execParameters = tools[0]?.parameters as Record<string, unknown>;
    const execProperties = execParameters.properties as Record<string, unknown>;
    expect(execProperties.env).toMatchObject({
      type: "array",
      items: {
        properties: { key: { type: "string" }, value: { type: "string" } },
        required: ["key", "value"],
        additionalProperties: false,
      },
    });
    expect(JSON.stringify(execProperties.env)).not.toContain("patternProperties");
    const input = capturedPayload?.input as Array<Record<string, unknown>>;
    expect(JSON.parse(input[0]?.arguments as string)).toEqual({
      command: "node app.js",
      env: [{ key: "NODE_ENV", value: "test" }],
    });
    expect(input[1]?.arguments).toEqual({
      providerOptions: [
        { key: "label", value: '"42"' },
        { key: "seed", value: "42" },
        { key: "enabled", value: "true" },
        { key: "empty", value: "null" },
      ],
    });
    expect(events[0]).toMatchObject({
      type: "toolcall_end",
      toolCall: { arguments: { command: "node app.js", env: { NODE_ENV: "test" } } },
    });
    expect(events[1]).toMatchObject({
      type: "toolcall_end",
      toolCall: {
        arguments: {
          props: [
            { key: "title", value: '"first"' },
            { key: "title", value: '"second"' },
          ],
        },
      },
    });
    expect(events[2]).toMatchObject({
      type: "toolcall_end",
      toolCall: {
        arguments: { providerOptions: [{ key: "broken", value: "not-json" }] },
      },
    });
    expect(events[3]).toMatchObject({
      type: "done",
      message: {
        content: [
          {
            arguments: {
              providerOptions: { label: "42", seed: 42, enabled: true, empty: null },
            },
          },
        ],
      },
    });
    await expect(stream.result()).resolves.toMatchObject({
      content: [
        {
          arguments: {
            providerOptions: { label: "42", seed: 42, enabled: true, empty: null },
          },
        },
      ],
    });
  });

  it("rebuilds dynamic record metadata when a Responses request payload is rebuilt", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const firstPayload = {
      tools: [
        {
          type: "function",
          name: "exec",
          parameters: {
            type: "object",
            properties: {
              env: {
                type: "object",
                patternProperties: { "^.*$": { type: "string" } },
              },
            },
          },
        },
      ],
    };
    const secondPayload = {
      tools: [
        {
          type: "function",
          name: "exec",
          parameters: {
            type: "object",
            properties: { env: { type: "array", items: { type: "string" } } },
          },
        },
      ],
    };
    const baseStreamFn: StreamFn = async (model, _context, options) => {
      await options?.onPayload?.(firstPayload, model);
      await options?.onPayload?.(secondPayload, model);
      const source = createAssistantMessageEventStream();
      queueMicrotask(() =>
        source.end(
          toolCallMessage("exec", {
            env: [{ key: "literal", value: "array" }],
          }),
        ),
      );
      return source;
    };
    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      providerId: "opencode",
      modelId: "gpt-5.6-sol",
    } as never);

    const stream = await streamFn?.(
      { provider: "opencode", id: "gpt-5.6-sol", api: "openai-responses" } as never,
      { messages: [] } as never,
      {},
    );

    expect(firstPayload.tools[0]?.parameters.properties.env.type).toBe("array");
    expect(secondPayload.tools[0]?.parameters.properties.env).toEqual({
      type: "array",
      items: { type: "string" },
    });
    await expect(stream?.result()).resolves.toMatchObject({
      content: [
        {
          arguments: { env: [{ key: "literal", value: "array" }] },
        },
      ],
    });
  });

  it("leaves web_search unchanged for non-Responses OpenCode models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const source = createAssistantMessageEventStream();
    const payload = { tools: [{ type: "function", name: "web_search" }] };
    const baseStreamFn: StreamFn = (model, _context, options) => {
      void options?.onPayload?.(payload, model);
      queueMicrotask(() => source.end(toolCallMessage("web_search")));
      return source;
    };
    const streamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      providerId: "opencode",
      modelId: "kimi-k2.6",
    } as never);

    const stream = await streamFn?.(
      { provider: "opencode", id: "kimi-k2.6", api: "openai-completions" } as never,
      { messages: [] } as never,
      {},
    );
    expect(stream).toBe(source);
    expect(payload.tools[0]?.name).toBe("web_search");
  });
});
