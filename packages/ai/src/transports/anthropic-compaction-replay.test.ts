import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  buildAnthropicReplayPlan,
  createCompactionCapture,
  isAnthropicReplayRejection,
  suppressAnthropicCompaction,
} from "./anthropic-compaction-replay.js";

const model = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
} satisfies Model<"anthropic-messages">;

const replayOptions = {
  enabled: true,
  sessionId: "session-1",
  authProfileId: "anthropic:work",
};

type ReplayOptions = {
  enabled?: boolean;
  sessionId?: string;
  authProfileId?: string;
};

function assistant(texts: string[]): AssistantMessage {
  return {
    role: "assistant",
    content: texts.map((text) => ({ type: "text" as const, text })),
    api: "anthropic-messages",
    provider: "anthropic",
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function captureCheckpoint(
  message: AssistantMessage,
  summary: string,
  replayIndex: number,
  options: ReplayOptions = replayOptions,
  captureModel: Model = model,
): void {
  const capture = createCompactionCapture(message, captureModel, options);
  capture.begin(0, { type: "compaction", content: summary }, replayIndex);
  capture.complete(0);
}

function contextWithCheckpoint(
  summary = "summary of the earlier conversation",
  options: ReplayOptions = replayOptions,
  captureModel: Model = model,
): Context {
  const checkpoint = assistant(["before checkpoint", "after checkpoint"]);
  captureCheckpoint(checkpoint, summary, 1, options, captureModel);
  return {
    messages: [
      { role: "user", content: "old question", timestamp: 0 },
      checkpoint,
      { role: "user", content: "new question", timestamp: 2 },
    ],
  };
}

describe("Anthropic compaction replay", () => {
  it("captures the complete route-fenced identity", () => {
    const context = contextWithCheckpoint();
    const checkpoint = context.messages[1];

    expect(checkpoint?.role).toBe("assistant");
    if (checkpoint?.role !== "assistant") {
      throw new Error("missing checkpoint assistant");
    }
    expect(checkpoint.providerReplay).toMatchObject({
      v: 1,
      type: "anthropic-compaction",
      data: "summary of the earlier conversation",
      replayIndex: 1,
      provider: "anthropic",
      api: "anthropic-messages",
      model: model.id,
    });
    expect(checkpoint.providerReplay?.baseUrlHash).toBeTypeOf("string");
    expect(checkpoint.providerReplay?.sessionHash).toBeTypeOf("string");
    expect(checkpoint.providerReplay?.authProfileHash).toBeTypeOf("string");
  });

  it.each([
    {
      name: "exact identity",
      captureModel: model,
      captureOptions: replayOptions,
      requestModel: model,
      requestOptions: replayOptions,
    },
    {
      name: "surrounding whitespace",
      captureModel: { ...model, baseUrl: ` ${model.baseUrl} ` },
      captureOptions: {
        enabled: true,
        sessionId: ` ${replayOptions.sessionId} `,
        authProfileId: ` ${replayOptions.authProfileId} `,
      },
      requestModel: model,
      requestOptions: replayOptions,
    },
    {
      name: "blank and missing optional identity",
      captureModel: model,
      captureOptions: { enabled: true, sessionId: " ", authProfileId: "" },
      requestModel: model,
      requestOptions: { enabled: true },
    },
  ])(
    "replays and slices the checkpoint for $name",
    ({ captureModel, captureOptions, requestModel, requestOptions }) => {
      const context = contextWithCheckpoint(
        "summary of the earlier conversation",
        captureOptions,
        captureModel,
      );
      const plan = buildAnthropicReplayPlan(context.messages, requestModel, requestOptions);

      expect(plan.compaction).toEqual({
        type: "compaction",
        content: "summary of the earlier conversation",
      });
      expect(plan.messages.map((message) => message.role)).toEqual(["assistant", "user"]);
      expect(plan.messages[0]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "after checkpoint" }],
      });
    },
  );

  it("uses the newest matching checkpoint", () => {
    const context = contextWithCheckpoint("older summary");
    const newest = assistant(["latest answer"]);
    captureCheckpoint(newest, "newest summary", 0);
    context.messages.push({ role: "user", content: "middle", timestamp: 3 }, newest, {
      role: "user",
      content: "latest question",
      timestamp: 4,
    });

    const plan = buildAnthropicReplayPlan(context.messages, model, replayOptions);

    expect(plan.compaction?.content).toBe("newest summary");
    expect(plan.messages).toHaveLength(2);
    expect(plan.messages[0]).toMatchObject({ role: "assistant", content: newest.content });
  });

  it.each([
    {
      name: "session",
      requestModel: model,
      requestOptions: { ...replayOptions, sessionId: "session-2" },
    },
    {
      name: "auth profile",
      requestModel: model,
      requestOptions: { ...replayOptions, authProfileId: "anthropic:personal" },
    },
    {
      name: "base URL",
      requestModel: { ...model, baseUrl: "https://api.example.com/v1" },
      requestOptions: replayOptions,
    },
    {
      name: "provider",
      requestModel: { ...model, provider: "other-provider" },
      requestOptions: replayOptions,
    },
    {
      name: "API",
      requestModel: { ...model, api: "openai-responses" as const },
      requestOptions: replayOptions,
    },
    {
      name: "model",
      requestModel: { ...model, id: "claude-opus-5" },
      requestOptions: replayOptions,
    },
  ])("falls back to full history when the $name differs", ({ requestModel, requestOptions }) => {
    const context = contextWithCheckpoint();

    const plan = buildAnthropicReplayPlan(context.messages, requestModel, requestOptions);

    expect(plan).toEqual({ messages: context.messages });
  });

  it("uses a matching suppression tombstone to stop replaying a rejected checkpoint", () => {
    const context = contextWithCheckpoint();
    const rejected = assistant([]);
    suppressAnthropicCompaction(rejected, model, replayOptions);
    context.messages.push(rejected);

    const plan = buildAnthropicReplayPlan(context.messages, model, replayOptions);

    expect(plan).toEqual({ messages: context.messages });
    expect(rejected.providerReplay).toMatchObject({
      type: "anthropic-compaction-suppression",
      data: "rejected",
    });
  });

  it("recognizes only targeted 400 replay rejections", () => {
    expect(
      isAnthropicReplayRejection({
        status: 400,
        message: "context_management compaction block is invalid",
      }),
    ).toBe(true);
    expect(
      isAnthropicReplayRejection(new Error("HTTP 400: compaction content could not be replayed")),
    ).toBe(true);
    expect(isAnthropicReplayRejection({ status: 400, message: "invalid model" })).toBe(false);
    expect(isAnthropicReplayRejection({ status: 500, message: "compaction failed" })).toBe(false);
  });
});
