import { describe, expect, it, vi } from "vitest";
import {
  handleToolExecutionEnd,
  handleToolExecutionStart,
} from "./pi-embedded-subscribe.handlers.tools.js";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";

// Minimal mock context factory. Only the fields needed for the media emission path.
function createMockContext(overrides?: {
  shouldEmitToolOutput?: boolean;
  onToolResult?: ReturnType<typeof vi.fn>;
  toolResultFormat?: "markdown" | "plain";
  builtinToolNames?: ReadonlySet<string>;
}): EmbeddedPiSubscribeContext {
  const onToolResult = overrides?.onToolResult ?? vi.fn();
  return {
    params: {
      runId: "test-run",
      onToolResult,
      onAgentEvent: vi.fn(),
      toolResultFormat: overrides?.toolResultFormat,
    },
    state: {
      toolMetaById: new Map(),
      toolMetas: [],
      toolSummaryById: new Set(),
      itemActiveIds: new Set(),
      itemStartedCount: 0,
      itemCompletedCount: 0,
      pendingMessagingTexts: new Map(),
      pendingMessagingTargets: new Map(),
      pendingMessagingMediaUrls: new Map(),
      pendingToolMediaUrls: [],
      pendingToolAudioAsVoice: false,
      messagingToolSentTexts: [],
      messagingToolSentTextsNormalized: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      deterministicApprovalPromptPending: false,
      deterministicApprovalPromptSent: false,
    },
    log: { debug: vi.fn(), warn: vi.fn() },
    builtinToolNames: overrides?.builtinToolNames,
    shouldEmitToolResult: vi.fn(() => false),
    shouldEmitToolOutput: vi.fn(() => overrides?.shouldEmitToolOutput ?? false),
    emitToolSummary: vi.fn(),
    emitToolOutput: vi.fn(),
    trimMessagingToolSent: vi.fn(),
    emitBlockReply: vi.fn(),
    hookRunner: undefined,
    // Fill in remaining required fields with no-ops.
    blockChunker: null,
    noteLastAssistant: vi.fn(),
    stripBlockTags: vi.fn((t: string) => t),
    emitBlockChunk: vi.fn(),
    flushBlockReplyBuffer: vi.fn(),
    emitReasoningStream: vi.fn(),
    consumeReplyDirectives: vi.fn(() => null),
    consumePartialReplyDirectives: vi.fn(() => null),
    resetAssistantMessageState: vi.fn(),
    resetForCompactionRetry: vi.fn(),
    finalizeAssistantTexts: vi.fn(),
    ensureCompactionPromise: vi.fn(),
    noteCompactionRetry: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
    recordAssistantUsage: vi.fn(),
    incrementCompactionCount: vi.fn(),
    getUsageTotals: vi.fn(() => undefined),
    getCompactionCount: vi.fn(() => 0),
  } as unknown as EmbeddedPiSubscribeContext;
}

async function emitPngMediaToolResult(
  ctx: EmbeddedPiSubscribeContext,
  opts?: { isError?: boolean },
) {
  await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName: "browser",
    toolCallId: "tc-1",
    isError: opts?.isError ?? false,
    result: {
      content: [
        { type: "text", text: "MEDIA:/tmp/screenshot.png" },
        { type: "image", data: "base64", mimeType: "image/png" },
      ],
      details: { path: "/tmp/screenshot.png" },
    },
  });
}

async function emitUntrustedToolMediaResult(
  ctx: EmbeddedPiSubscribeContext,
  mediaPathOrUrl: string,
) {
  await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName: "plugin_tool",
    toolCallId: "tc-1",
    isError: false,
    result: {
      content: [{ type: "text", text: `MEDIA:${mediaPathOrUrl}` }],
    },
  });
}

async function emitMcpMediaToolResult(ctx: EmbeddedPiSubscribeContext, mediaPathOrUrl: string) {
  await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName: "browser",
    toolCallId: "tc-1",
    isError: false,
    result: {
      content: [{ type: "text", text: `MEDIA:${mediaPathOrUrl}` }],
      details: {
        mcpServer: "probe",
        mcpTool: "browser",
      },
    },
  });
}

async function handleCaseVariantBuiltinMedia(mediaPathOrUrl: string) {
  const ctx = createMockContext({
    shouldEmitToolOutput: false,
    onToolResult: vi.fn(),
    builtinToolNames: new Set(["web_search"]),
  });

  await handleToolExecutionEnd(ctx, {
    type: "tool_execution_end",
    toolName: "Web_Search",
    toolCallId: "tc-1",
    isError: false,
    result: {
      content: [{ type: "text", text: `MEDIA:${mediaPathOrUrl}` }],
    },
  });

  return ctx;
}

describe("handleToolExecutionEnd media emission", () => {
  it("does not warn for read tool when path is provided via file_path alias", async () => {
    const ctx = createMockContext();

    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tc-1",
      args: { file_path: "README.md" },
    });

    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("emits media when verbose is off and tool result has MEDIA: path", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitPngMediaToolResult(ctx);

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/screenshot.png"]);
  });

  it("preserves audio_as_voice when queuing trusted text MEDIA tool output", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({
      shouldEmitToolOutput: false,
      onToolResult,
      builtinToolNames: new Set(["tts"]),
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "Generated audio reply.\n[[audio_as_voice]]\nMEDIA:/tmp/reply.opus",
          },
        ],
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
  });

  it("does NOT emit local media for untrusted tools", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitUntrustedToolMediaResult(ctx, "/tmp/secret.png");

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("emits remote media for untrusted tools", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitUntrustedToolMediaResult(ctx, "https://example.com/file.png");

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["https://example.com/file.png"]);
  });

  it("does NOT emit local media for MCP-provenance results", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitMcpMediaToolResult(ctx, "/tmp/secret.png");

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("does NOT emit local media for case-variant collisions with trusted built-ins", async () => {
    const ctx = await handleCaseVariantBuiltinMedia("/tmp/secret.png");

    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("still emits remote media for case-variant collisions with trusted built-ins", async () => {
    const ctx = await handleCaseVariantBuiltinMedia("https://example.com/file.png");

    expect(ctx.state.pendingToolMediaUrls).toEqual(["https://example.com/file.png"]);
  });

  it("emits remote media for MCP-provenance results", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitMcpMediaToolResult(ctx, "https://example.com/file.png");

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["https://example.com/file.png"]);
  });

  it("does NOT queue text MEDIA paths when verbose is full", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: true, onToolResult });

    await emitPngMediaToolResult(ctx);

    // onToolResult should NOT be called by the new media path (emitToolOutput handles it).
    // It may be called by emitToolOutput, but the new block should not fire.
    // Verify emitToolOutput was called instead.
    expect(ctx.emitToolOutput).toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("queues TTS structured media without leaking spoken text when verbose is full", async () => {
    const ctx = createMockContext({
      shouldEmitToolOutput: true,
      onToolResult: vi.fn(),
      toolResultFormat: "plain",
      builtinToolNames: new Set(["tts"]),
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [{ type: "text", text: "(spoken) hello" }],
        details: {
          media: {
            mediaUrl: "/tmp/reply.opus",
            audioAsVoice: true,
          },
        },
      },
    });

    expect(ctx.emitToolOutput).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
  });

  it("queues one voice copy when TTS output also contains a legacy media directive", async () => {
    const ctx = createMockContext({
      shouldEmitToolOutput: true,
      onToolResult: vi.fn(),
      toolResultFormat: "plain",
      builtinToolNames: new Set(["tts"]),
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [{ type: "text", text: "Generated audio reply.\nMEDIA:/tmp/reply.opus" }],
        details: {
          media: {
            mediaUrl: "/tmp/reply.opus",
            audioAsVoice: true,
          },
        },
      },
    });

    expect(ctx.emitToolOutput).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
  });

  it("keeps verbose TTS text when structured local media is not trusted", async () => {
    const ctx = createMockContext({
      shouldEmitToolOutput: true,
      onToolResult: vi.fn(),
      toolResultFormat: "plain",
      builtinToolNames: new Set(["tts"]),
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "TTS",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [{ type: "text", text: "(spoken) hello" }],
        details: {
          media: {
            mediaUrl: "/tmp/reply.opus",
            audioAsVoice: true,
          },
        },
      },
    });

    expect(ctx.emitToolOutput).toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(false);
  });

  it("keeps verbose TTS text for non-builtin remote media collisions", async () => {
    const ctx = createMockContext({
      shouldEmitToolOutput: true,
      onToolResult: vi.fn(),
      toolResultFormat: "plain",
      builtinToolNames: new Set(["web_search"]),
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [{ type: "text", text: "remote tool output" }],
        details: {
          media: {
            mediaUrl: "https://example.com/reply.opus",
            audioAsVoice: true,
          },
        },
      },
    });

    expect(ctx.emitToolOutput).toHaveBeenCalledWith(
      "tts",
      undefined,
      "remote tool output",
      expect.any(Object),
    );
    expect(ctx.state.pendingToolMediaUrls).toEqual(["https://example.com/reply.opus"]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
  });

  async function handleVerboseGeneratedImage(toolResultFormat: "plain" | "markdown") {
    const ctx = createMockContext({
      shouldEmitToolOutput: true,
      onToolResult: vi.fn(),
      toolResultFormat,
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "image_generate",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "Generated 1 image with google/gemini-3.1-flash-image-preview.\nMEDIA:/tmp/generated.png",
          },
        ],
        details: {
          media: {
            mediaUrls: ["/tmp/generated.png"],
          },
        },
      },
    });

    return ctx;
  }

  it("does not queue structured media already emitted in plain verbose output", async () => {
    const ctx = await handleVerboseGeneratedImage("plain");

    expect(ctx.emitToolOutput).toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("queues structured media once for markdown verbose output", async () => {
    const ctx = await handleVerboseGeneratedImage("markdown");

    expect(ctx.emitToolOutput).toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/generated.png"]);
  });

  it("emits provider inventory output for compact video_generate list results", async () => {
    const ctx = createMockContext({
      shouldEmitToolOutput: false,
      onToolResult: vi.fn(),
      toolResultFormat: "plain",
    });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "video_generate",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: [
              "openai: default=sora-2 | models=sora-2",
              "google: default=veo-3.1-fast-generate-preview | models=veo-3.1-fast-generate-preview",
            ].join("\n"),
          },
        ],
        details: {
          providers: [
            { id: "openai", defaultModel: "sora-2", models: ["sora-2"] },
            {
              id: "google",
              defaultModel: "veo-3.1-fast-generate-preview",
              models: ["veo-3.1-fast-generate-preview"],
            },
          ],
        },
      },
    });

    expect(ctx.emitToolOutput).toHaveBeenCalledWith(
      "video_generate",
      undefined,
      [
        "openai: default=sora-2 | models=sora-2",
        "google: default=veo-3.1-fast-generate-preview | models=veo-3.1-fast-generate-preview",
      ].join("\n"),
      expect.any(Object),
    );
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("does NOT emit media for error results", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await emitPngMediaToolResult(ctx, { isError: true });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("does NOT emit when tool result has no media", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [{ type: "text", text: "Command executed successfully" }],
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("does NOT emit media for <media:audio> placeholder text", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "<media:audio> placeholder with successful preflight voice transcript",
          },
        ],
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("does NOT emit media for malformed MEDIA:-prefixed prose", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "browser",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: "MEDIA:-prefixed paths (lenient whitespace) when loading outbound media",
          },
        ],
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual([]);
  });

  it("queues media from details.path fallback when no MEDIA: text", async () => {
    const onToolResult = vi.fn();
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "canvas",
      toolCallId: "tc-1",
      isError: false,
      result: {
        content: [
          { type: "text", text: "Rendered canvas" },
          { type: "image", data: "base64", mimeType: "image/png" },
        ],
        details: { path: "/tmp/canvas-output.png" },
      },
    });

    expect(onToolResult).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/canvas-output.png"]);
  });

  it("queues structured details.media and voice metadata", async () => {
    const ctx = createMockContext({ shouldEmitToolOutput: false, onToolResult: vi.fn() });

    await handleToolExecutionEnd(ctx, {
      type: "tool_execution_end",
      toolName: "tts",
      toolCallId: "tc-1",
      isError: false,
      result: {
        details: {
          media: {
            mediaUrl: "/tmp/reply.opus",
            audioAsVoice: true,
          },
        },
      },
    });

    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
  });
});
