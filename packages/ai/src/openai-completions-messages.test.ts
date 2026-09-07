import { describe, expect, it } from "vitest";
import { convertMessages } from "./openai-completions-messages.js";
import type { ProviderContext, ProviderModel } from "./provider-types.js";
import { resolveOpenAICompletionsCompat } from "./transports/openai-completions-compat.js";
import type { AssistantMessage, Context, Model } from "./types.js";
import { createZeroUsage } from "./usage.test-support.js";
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END,
} from "./utils/system-prompt-cache-boundary.js";

const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "custom-openai-compatible",
  baseUrl: "https://proxy.example/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
};

const emptyUsage = createZeroUsage();

describe("convertMessages assistant text replay", () => {
  it("serializes advertised video in ordered Chat Completions user content", () => {
    const videoModel = {
      ...model,
      input: ["text", "image", "video"],
    } as ProviderModel<"openai-completions">;
    const context: ProviderContext = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "before" },
            { type: "image", mimeType: "image/png", data: "image" },
            { type: "video", mimeType: "video/mp4", data: "video" },
            { type: "text", text: "after" },
          ],
          timestamp: 1,
        },
      ],
    };

    const converted = convertMessages(
      videoModel as Model<"openai-completions">,
      context as Context,
      resolveOpenAICompletionsCompat(videoModel as Model<"openai-completions">),
    );

    expect(converted[0]?.content).toEqual([
      { type: "text", text: "before" },
      { type: "image_url", image_url: { url: "data:image/png;base64,image" } },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,video" } },
      { type: "text", text: "after" },
    ]);
  });

  it("keeps separate assistant text blocks apart", () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        { type: "text", text: "Let me check the file." },
        { type: "text", text: "The file contains X." },
      ],
      usage: emptyUsage,
      stopReason: "stop",
      timestamp: 2,
    };
    const context: Context = {
      messages: [{ role: "user", content: "hello", timestamp: 1 }, assistant],
    };

    const converted = convertMessages(model, context, resolveOpenAICompletionsCompat(model));

    const replayed = converted.find((message) => message.role === "assistant");
    expect(replayed?.content).toBe("Let me check the file.\nThe file contains X.");
  });

  it.each([false, true])(
    "preserves interleaved text, thinking, and tool replay with thinking-as-text %s",
    (requiresThinkingAsText) => {
      const assistant: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [
          { type: "thinking", thinking: " \t", thinkingSignature: "reasoning_text" },
          {
            type: "thinking",
            thinking: "reason\ud800",
            thinkingSignature: "reasoning_content",
          },
          { type: "text", text: " \t" },
          { type: "text", text: "first\ud800" },
          { type: "text", text: "\udc00" },
          {
            type: "toolCall",
            id: "call_lookup",
            name: "lookup",
            arguments: { query: "cats" },
            thoughtSignature: '{"type":"reasoning.encrypted","data":"synthetic"}',
          },
          { type: "thinking", thinking: "next😀", thinkingSignature: "reasoning_text" },
          { type: "text", text: "last😀" },
        ],
        usage: emptyUsage,
        stopReason: "toolUse",
        timestamp: 2,
      };
      const converted = convertMessages(
        model,
        {
          messages: [
            assistant,
            {
              role: "toolResult",
              toolCallId: "call_lookup",
              toolName: "lookup",
              content: [{ type: "text", text: "found" }],
              isError: false,
              timestamp: 3,
            },
          ],
        },
        { ...resolveOpenAICompletionsCompat(model), requiresThinkingAsText },
      );

      expect(converted).toEqual([
        {
          role: "assistant",
          content: requiresThinkingAsText
            ? [
                { type: "text", text: "reason\n\nnext😀" },
                { type: "text", text: "first" },
                { type: "text", text: "" },
                { type: "text", text: "last😀" },
              ]
            : "first\n\nlast😀",
          ...(!requiresThinkingAsText && { reasoning_content: "reason\ud800\nnext😀" }),
          tool_calls: [
            {
              id: "call_lookup",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"cats"}' },
            },
          ],
          reasoning_details: [{ type: "reasoning.encrypted", data: "synthetic" }],
        },
        { role: "tool", content: "found", tool_call_id: "call_lookup" },
      ]);
    },
  );

  it("keeps paired OpenAI tool call ids UTF-16 safe when truncating", () => {
    const prefix = "a".repeat(39);
    const oversizedId = `${prefix}🐱`;
    const targetModel: Model<"openai-completions"> = {
      ...model,
      id: "target-model",
      provider: "openai",
    };
    const assistant: AssistantMessage = {
      role: "assistant",
      api: targetModel.api,
      provider: targetModel.provider,
      model: "source-model",
      content: [{ type: "toolCall", id: oversizedId, name: "lookup", arguments: {} }],
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 1,
    };
    const context: Context = {
      messages: [
        assistant,
        {
          role: "toolResult",
          toolCallId: oversizedId,
          toolName: "lookup",
          content: [{ type: "text", text: "ok" }],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    const converted = convertMessages(
      targetModel,
      context,
      resolveOpenAICompletionsCompat(targetModel),
    );
    const assistantParam = converted.find((message) => message.role === "assistant");
    const toolParam = converted.find((message) => message.role === "tool");
    const normalizedAssistantId =
      assistantParam?.role === "assistant" ? assistantParam.tool_calls?.[0]?.id : undefined;
    const normalizedToolResultId = toolParam?.role === "tool" ? toolParam.tool_call_id : undefined;

    expect(oversizedId.slice(0, 40).charCodeAt(39)).toBe(0xd83d);
    expect(normalizedAssistantId).toBe(prefix);
    expect(normalizedToolResultId).toBe(prefix);
  });
});

describe("convertMessages parallel tool-result image ownership", () => {
  const imageModel: Model<"openai-completions"> = {
    ...model,
    input: ["text", "image"],
  };

  function makeToolCallAssistant(callIds: string[], toolNames: string[]): AssistantMessage {
    return {
      role: "assistant",
      api: imageModel.api,
      provider: imageModel.provider,
      model: imageModel.id,
      content: callIds.map((id, idx) => ({
        type: "toolCall" as const,
        id,
        name: toolNames[idx] ?? id,
        arguments: {},
      })),
      usage: emptyUsage,
      stopReason: "toolUse",
      timestamp: 1,
    };
  }

  function makeImageToolResult(
    callId: string,
    toolName: string,
    images: Array<{ mimeType: string; data: string }>,
  ) {
    return {
      role: "toolResult" as const,
      toolCallId: callId,
      toolName,
      content: images.map((img) => ({
        type: "image" as const,
        mimeType: img.mimeType,
        data: img.data,
      })),
      isError: false,
      timestamp: 2,
    };
  }

  it("distinguishes image ownership between different parallel result partitions", () => {
    const imgA = { mimeType: "image/png", data: "AAAA" };
    const imgB = { mimeType: "image/png", data: "BBBB" };
    const imgC = { mimeType: "image/png", data: "CCCC" };

    // Partition P: call_a=[A], call_b=[B,C]
    const contextP: Context = {
      messages: [
        makeToolCallAssistant(["call_a", "call_b"], ["screenshot", "camera"]),
        makeImageToolResult("call_a", "screenshot", [imgA]),
        makeImageToolResult("call_b", "camera", [imgB, imgC]),
      ],
    };

    // Partition Q: call_a=[A,B], call_b=[C]
    const contextQ: Context = {
      messages: [
        makeToolCallAssistant(["call_a", "call_b"], ["screenshot", "camera"]),
        makeImageToolResult("call_a", "screenshot", [imgA, imgB]),
        makeImageToolResult("call_b", "camera", [imgC]),
      ],
    };

    const convertedP = convertMessages(
      imageModel,
      contextP,
      resolveOpenAICompletionsCompat(imageModel),
    );
    const convertedQ = convertMessages(
      imageModel,
      contextQ,
      resolveOpenAICompletionsCompat(imageModel),
    );

    const userMsgP = convertedP.find((m) => m.role === "user" && Array.isArray(m.content));
    const userMsgQ = convertedQ.find((m) => m.role === "user" && Array.isArray(m.content));

    // The two partitions must produce different content (ownership is distinguishable)
    expect(JSON.stringify(userMsgP?.content)).not.toBe(JSON.stringify(userMsgQ?.content));

    // Partition P: first group has 1 image from screenshot, second has 2 from camera
    const contentP = userMsgP?.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(contentP).toEqual([
      { type: "text", text: "Image(s) from tool result #1 (screenshot):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "text", text: "Image(s) from tool result #2 (camera):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,CCCC" } },
    ]);

    // Partition Q: first group has 2 images from screenshot, second has 1 from camera
    const contentQ = userMsgQ?.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(contentQ).toEqual([
      { type: "text", text: "Image(s) from tool result #1 (screenshot):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      { type: "text", text: "Image(s) from tool result #2 (camera):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,CCCC" } },
    ]);
  });

  it("labels single tool-result images with result position and tool name", () => {
    const context: Context = {
      messages: [
        makeToolCallAssistant(["call_x"], ["screenshot"]),
        makeImageToolResult("call_x", "screenshot", [{ mimeType: "image/png", data: "aW1n" }]),
      ],
    };

    const converted = convertMessages(
      imageModel,
      context,
      resolveOpenAICompletionsCompat(imageModel),
    );

    const userMsg = converted.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(userMsg?.content).toEqual([
      { type: "text", text: "Image(s) from tool result #1 (screenshot):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
    ]);
  });

  it.each(["screenshot", ""])(
    "counts every reply when labeling sparse images from tool %j",
    (toolName) => {
      const prefix = "x".repeat(64);
      const callIds: [string, string, string, string] = [
        `${prefix}a`,
        `${prefix}b`,
        `${prefix}c`,
        `${prefix}d`,
      ];
      const context: Context = {
        messages: [
          makeToolCallAssistant(
            callIds,
            callIds.map(() => toolName),
          ),
          {
            role: "toolResult",
            toolCallId: callIds[0],
            toolName,
            content: [{ type: "text", text: "No image from this call" }],
            isError: false,
            timestamp: 2,
          },
          makeImageToolResult(callIds[1], toolName, [{ mimeType: "image/png", data: "AAAA" }]),
          makeImageToolResult(callIds[2], toolName, []),
          makeImageToolResult(callIds[3], toolName, [{ mimeType: "image/png", data: "BBBB" }]),
        ],
      };
      const converted = convertMessages(
        imageModel,
        context,
        resolveOpenAICompletionsCompat(imageModel),
      );

      expect(
        converted
          .filter((message) => message.role === "tool")
          .map((message) => message.tool_call_id),
      ).toEqual(callIds);
      const nameSuffix = toolName ? ` (${toolName})` : "";
      expect(converted.find((message) => message.role === "user")?.content).toEqual([
        { type: "text", text: `Image(s) from tool result #2${nameSuffix}:` },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "text", text: `Image(s) from tool result #4${nameSuffix}:` },
        { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
      ]);
    },
  );

  it("does not emit a user message when tool results have no images", () => {
    const context: Context = {
      messages: [
        makeToolCallAssistant(["call_a", "call_b"], ["lookup", "search"]),
        {
          role: "toolResult",
          toolCallId: "call_a",
          toolName: "lookup",
          content: [{ type: "text", text: "found it" }],
          isError: false,
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_b",
          toolName: "search",
          content: [{ type: "text", text: "no results" }],
          isError: false,
          timestamp: 3,
        },
      ],
    };

    const converted = convertMessages(
      imageModel,
      context,
      resolveOpenAICompletionsCompat(imageModel),
    );

    const userMsgs = converted.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(0);
  });

  it("handles mixed text and image tool results", () => {
    const context: Context = {
      messages: [
        makeToolCallAssistant(["call_a"], ["screenshot"]),
        {
          role: "toolResult",
          toolCallId: "call_a",
          toolName: "screenshot",
          content: [
            { type: "text", text: "Captured screen region" },
            { type: "image", mimeType: "image/png", data: "aW1n" },
          ],
          isError: false,
          timestamp: 2,
        },
      ],
    };

    const converted = convertMessages(
      imageModel,
      context,
      resolveOpenAICompletionsCompat(imageModel),
    );

    // Tool message gets the text content
    const toolMsg = converted.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({
      role: "tool",
      content: "Captured screen region",
      tool_call_id: "call_a",
    });

    // User message gets the labeled image
    const userMsg = converted.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(userMsg?.content).toEqual([
      { type: "text", text: "Image(s) from tool result #1 (screenshot):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
    ]);
  });

  it("bounds tool names without changing full call identifiers", () => {
    const namePrefix = "x".repeat(63);
    const longName = `${namePrefix}🙂tail`;
    const longCallId = `${"y".repeat(200)}🙂`;
    const context: Context = {
      messages: [
        makeToolCallAssistant([longCallId], [longName]),
        makeImageToolResult(longCallId, longName, [{ mimeType: "image/png", data: "aW1n" }]),
      ],
    };

    const converted = convertMessages(
      imageModel,
      context,
      resolveOpenAICompletionsCompat(imageModel),
    );

    const userMsg = converted.find((m) => m.role === "user" && Array.isArray(m.content));
    const content = userMsg?.content as Array<{ type: string; text?: string }>;
    const labelText = content[0]?.text ?? "";

    expect(labelText).toBe(`Image(s) from tool result #1 (${namePrefix}):`);
    expect(labelText).not.toMatch(/[\uD800-\uDFFF]/u);
    const toolMessage = converted.find((message) => message.role === "tool");
    expect(toolMessage?.role === "tool" && toolMessage.tool_call_id).toBe(longCallId);
  });
});

describe("convertMessages relocatable region", () => {
  const compat = () => resolveOpenAICompletionsCompat(model);
  /** Wrap producer-marked runtime facts the way the system prompt builder does. */
  const marked = (facts: string) =>
    `${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}${facts}${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}`;
  const contextForSession = (sessionId: string): Context =>
    ({
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Reactions guidance${marked(`## Runtime\nRuntime: session=${sessionId}`)}`,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    }) as unknown as Context;

  it("carries the non-behavioral region on the first user turn", () => {
    const converted = convertMessages(model, contextForSession("alpha"), compat());

    expect(converted[0]).toEqual({
      role: "system",
      content: "Stable prefix\nReactions guidance",
    });
    expect(converted[1]?.content).toBe("hi\n\n## Runtime\nRuntime: session=alpha");
  });

  it("keeps behavioral guidance at system authority", () => {
    // Only the marked region moves. Everything outside it, including guidance
    // that merely sits below the cache boundary, stays in the system message.
    const converted = convertMessages(model, contextForSession("alpha"), compat());

    expect(converted[0]?.content).toContain("Reactions guidance");
    expect(converted[1]?.content).not.toContain("Reactions guidance");
  });

  it("does not relocate when only the cache boundary is present", () => {
    const context = {
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Reactions guidance`,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    } as unknown as Context;

    const converted = convertMessages(model, context, compat());

    expect(converted[0]?.content).toBe("Stable prefix\nReactions guidance");
    expect(converted[1]?.content).toBe("hi");
  });

  it("keeps the system message byte-identical across sessions", () => {
    const first = convertMessages(model, contextForSession("alpha"), compat());
    const second = convertMessages(model, contextForSession("beta"), compat());

    expect(first[0]).toEqual(second[0]);
    expect(first[1]?.content).not.toEqual(second[1]?.content);
  });

  it("keeps the region in the system prompt when the only user turn projects away", () => {
    // Media projection can leave a user turn with no renderable content, and the
    // converter skips it. The region must survive rather than vanish with it.
    const context = {
      systemPrompt: `Stable prefix${marked("Runtime facts")}`,
      messages: [{ role: "user", content: [], timestamp: 1 }],
    } as unknown as Context;

    const converted = convertMessages(model, context, compat());

    expect(converted).toHaveLength(1);
    expect(converted[0]?.content).toBe("Stable prefix\nRuntime facts");
  });

  it("never leaks an internal marker to the provider", () => {
    const converted = convertMessages(model, contextForSession("alpha"), compat());

    expect(JSON.stringify(converted)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
    expect(JSON.stringify(converted)).not.toContain("OPENCLAW-RELOCATABLE-BOUNDARY");
  });

  it("leaves the boundary in place when the caller preserves it", () => {
    const converted = convertMessages(model, contextForSession("alpha"), compat(), {
      preserveSystemPromptCacheBoundary: true,
    });

    expect(converted[0]?.content).toContain(SYSTEM_PROMPT_CACHE_BOUNDARY.trim());
    expect(converted[1]?.content).toBe("hi");
  });

  it("leaves a trailing structural marker in the system prompt", () => {
    // The attempt-section marker closes a region of the system prompt; it must
    // not ride onto the user turn with the relocated facts. It sits outside the
    // marked region, so the closing boundary keeps it where it belongs.
    const context = {
      systemPrompt: `Stable prefix${marked("Runtime: session=alpha")}<!-- /openclaw:attempt:DYNAMIC -->`,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    } as unknown as Context;

    const converted = convertMessages(model, context, compat());

    expect(converted[0]?.content).toBe("Stable prefix\n<!-- /openclaw:attempt:DYNAMIC -->");
    expect(converted[1]?.content).toBe("hi\n\nRuntime: session=alpha");
  });

  it("keeps the previous turn byte-identical across follow-up requests", () => {
    // The region must not migrate to whichever user turn happens to be last: that
    // would change the earlier turn on every follow-up and fork the prefix
    // there, costing the whole prior exchange including tool results. Reported
    // on the PR by a reviewer who ran exactly this comparison.
    const toolResult = "X".repeat(30000);
    const turn1 = {
      systemPrompt: `Stable prefix${marked("Runtime: session=alpha")}`,
      messages: [{ role: "user", content: "user1", timestamp: 1 }],
    } as unknown as Context;
    const turn2 = {
      systemPrompt: `Stable prefix${marked("Runtime: session=alpha")}`,
      messages: [
        { role: "user", content: "user1", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: "{}" }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: toolResult }],
          toolCallId: "c1",
          timestamp: 3,
        },
        { role: "user", content: "user2", timestamp: 4 },
      ],
    } as unknown as Context;

    const first = convertMessages(model, turn1, compat());
    const second = convertMessages(model, turn2, compat());

    // Every param of turn 1 must appear unchanged at the same index in turn 2.
    for (let index = 0; index < first.length; index++) {
      expect(JSON.stringify(second[index])).toBe(JSON.stringify(first[index]));
    }
  });

  it("keeps the system message stable across conversations while doing so", () => {
    // The two properties are in tension: satisfying one by sacrificing the
    // other is the failure this pair guards against.
    const convo = (session: string, user: string): Context =>
      ({
        systemPrompt: `Stable prefix${marked(`Runtime: session=${session}`)}`,
        messages: [{ role: "user", content: user, timestamp: 1 }],
      }) as unknown as Context;

    const a = convertMessages(model, convo("alpha", "hello"), compat());
    const b = convertMessages(model, convo("beta", "hello"), compat());

    expect(a[0]).toEqual(b[0]);
    expect(a[1]?.content).not.toEqual(b[1]?.content);
  });

  it("keeps hook system context in the system message", () => {
    // `composeSystemPromptWithHookContext` appends `appendSystemContext` after
    // the built prompt, so it lands past the marked region. It is behavioral
    // instruction from a documented hook and must keep its system authority.
    const context = {
      systemPrompt: `Stable prefix${marked("Runtime: session=alpha")}## Team\nAlways answer in German.`,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    } as unknown as Context;

    const converted = convertMessages(model, context, compat());

    expect(converted[0]?.content).toBe("Stable prefix\n## Team\nAlways answer in German.");
    expect(converted[1]?.content).toBe("hi\n\nRuntime: session=alpha");
  });

  it("keeps a refreshed permission notice in the system message", () => {
    // `refreshSystemPrompt` appends its PERMISSION section to the end of the
    // prompt when none is present yet. Demoting that to user content would
    // lower the authority of retry and interrupted-action guidance.
    const notice = [
      "<!-- openclaw:attempt:PERMISSION -->",
      "Permissions changed. Inspect interrupted actions; do not repeat completed ones.",
      "<!-- /openclaw:attempt:PERMISSION -->",
    ].join("\n");
    const context = {
      systemPrompt: `Stable prefix${marked("Runtime: session=alpha")}\n${notice}`,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    } as unknown as Context;

    const converted = convertMessages(model, context, compat());

    expect(converted[0]?.content).toContain("Inspect interrupted actions");
    expect(converted[1]?.content).not.toContain("Inspect interrupted actions");
    expect(converted[1]?.content).toBe("hi\n\nRuntime: session=alpha");
  });

  it("does not relocate when the region is never closed", () => {
    // A prompt carrying only the opening marker is left whole: relocating its
    // remainder would sweep up whatever a caller appended after it.
    const context = {
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}Runtime: session=alpha`,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    } as unknown as Context;

    const converted = convertMessages(model, context, compat());

    expect(converted[0]?.content).toBe("Stable prefix\nRuntime: session=alpha");
    expect(converted[1]?.content).toBe("hi");
  });

  it("marks the carrying turn as cache opt-out", () => {
    const cacheOptOutIndexes = new Set<number>();

    convertMessages(model, contextForSession("alpha"), compat(), { cacheOptOutIndexes });

    expect(cacheOptOutIndexes.has(1)).toBe(true);
  });
});
