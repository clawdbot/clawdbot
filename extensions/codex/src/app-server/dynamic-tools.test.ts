import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../../../src/plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../../../src/plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../../../../src/plugins/registry.js";
import { setActivePluginRegistry } from "../../../../src/plugins/runtime.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type { JsonValue } from "./protocol.js";

function createTool(overrides: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name: "tts",
    description: "Convert text to speech.",
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
    ...overrides,
  } as unknown as AnyAgentTool;
}

function mediaResult(mediaUrl: string, audioAsVoice?: boolean): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: "Generated media reply." }],
    details: {
      media: {
        mediaUrl,
        ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
      },
    },
  };
}

function createBridgeWithToolResult(toolName: string, toolResult: AgentToolResult<unknown>) {
  return createCodexDynamicToolBridge({
    tools: [
      createTool({
        name: toolName,
        execute: vi.fn(async () => toolResult),
      }),
    ],
    signal: new AbortController().signal,
  });
}

function expectInputText(text: string) {
  return {
    success: true,
    contentItems: [{ type: "inputText", text }],
  };
}

async function handleMessageToolCall(
  bridge: ReturnType<typeof createCodexDynamicToolBridge>,
  arguments_: JsonValue,
) {
  return await bridge.handleToolCall({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-1",
    tool: "message",
    arguments: arguments_,
  });
}

afterEach(() => {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("createCodexDynamicToolBridge", () => {
  it.each([
    { toolName: "tts", mediaUrl: "/tmp/reply.opus", audioAsVoice: true },
    { toolName: "image_generate", mediaUrl: "/tmp/generated.png" },
    { toolName: "video_generate", mediaUrl: "https://media.example/video.mp4" },
    { toolName: "music_generate", mediaUrl: "https://media.example/music.wav" },
  ])(
    "preserves structured media artifacts from $toolName tool results",
    async ({ toolName, mediaUrl, audioAsVoice }) => {
      const bridge = createBridgeWithToolResult(toolName, mediaResult(mediaUrl, audioAsVoice));

      const result = await bridge.handleToolCall({
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        tool: toolName,
        arguments: { prompt: "hello" },
      });

      expect(result).toEqual(expectInputText("Generated media reply."));
      expect(bridge.telemetry.toolMediaUrls).toEqual([mediaUrl]);
      expect(bridge.telemetry.toolAudioAsVoice).toBe(audioAsVoice === true);
    },
  );

  it("preserves audio-as-voice metadata from tts results", async () => {
    const toolResult = {
      content: [{ type: "text", text: "(spoken) hello" }],
      details: {
        media: {
          mediaUrl: "/tmp/reply.opus",
          audioAsVoice: true,
        },
      },
    } satisfies AgentToolResult<unknown>;
    const tool = createTool({
      execute: vi.fn(async () => toolResult),
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "tts",
      arguments: { text: "hello" },
    });

    expect(result).toEqual({
      success: true,
      contentItems: [{ type: "inputText", text: "(spoken) hello" }],
    });
    expect(bridge.telemetry.toolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(bridge.telemetry.toolAudioAsVoice).toBe(true);
  });

  it("records messaging tool side effects while returning concise text to app-server", async () => {
    const toolResult = {
      content: [{ type: "text", text: "Sent." }],
      details: { messageId: "message-1" },
    } satisfies AgentToolResult<unknown>;
    const tool = createTool({
      name: "message",
      execute: vi.fn(async () => toolResult),
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
    });

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      text: "hello from Codex",
      mediaUrl: "/tmp/reply.png",
      provider: "telegram",
      to: "chat-1",
      threadId: "thread-ts-1",
    });

    expect(result).toEqual(expectInputText("Sent."));
    expect(bridge.telemetry).toMatchObject({
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["hello from Codex"],
      messagingToolSentMediaUrls: ["/tmp/reply.png"],
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "telegram",
          to: "chat-1",
          threadId: "thread-ts-1",
        },
      ],
    });
  });

  it("does not record messaging side effects when the send fails", async () => {
    const tool = createTool({
      name: "message",
      execute: vi.fn(async () => {
        throw new Error("send failed");
      }),
    });
    const bridge = createCodexDynamicToolBridge({
      tools: [tool],
      signal: new AbortController().signal,
    });

    const result = await handleMessageToolCall(bridge, {
      action: "send",
      text: "not delivered",
      provider: "slack",
      to: "C123",
    });

    expect(result).toEqual({
      success: false,
      contentItems: [{ type: "inputText", text: "send failed" }],
    });
    expect(bridge.telemetry).toMatchObject({
      didSendViaMessagingTool: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
    });
  });

  it("applies codex app-server tool_result extensions from the active plugin registry", async () => {
    const registry = createEmptyPluginRegistry();
    const factory = async (codex: {
      on: (
        event: "tool_result",
        handler: (event: any) => Promise<{ result: AgentToolResult<unknown> }>,
      ) => void;
    }) => {
      codex.on("tool_result", async (event) => ({
        result: {
          ...event.result,
          content: [{ type: "text", text: `${event.toolName} compacted` }],
        },
      }));
    };
    registry.codexAppServerExtensionFactories.push({
      pluginId: "tokenjuice",
      pluginName: "Tokenjuice",
      rawFactory: factory,
      factory,
      source: "test",
    });
    setActivePluginRegistry(registry);

    const bridge = createBridgeWithToolResult("exec", {
      content: [{ type: "text", text: "raw output" }],
      details: {},
    });

    const result = await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "exec",
      arguments: { command: "git status" },
    });

    expect(result).toEqual(expectInputText("exec compacted"));
  });

  it("fires after_tool_call for successful codex tool executions", async () => {
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "after_tool_call", handler: afterToolCall }]),
    );

    const bridge = createBridgeWithToolResult("exec", {
      content: [{ type: "text", text: "done" }],
      details: {},
    });

    await bridge.handleToolCall({
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "exec",
      arguments: { command: "pwd" },
    });

    await vi.waitFor(() => {
      expect(afterToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "exec",
          toolCallId: "call-1",
          params: { command: "pwd" },
          result: expect.objectContaining({
            content: [{ type: "text", text: "done" }],
            details: {},
          }),
        }),
        expect.objectContaining({
          toolName: "exec",
          toolCallId: "call-1",
        }),
      );
    });
  });
});
