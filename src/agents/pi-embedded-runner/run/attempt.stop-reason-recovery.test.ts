import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Context, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { wrapStreamFnHandleSensitiveStopReason } from "./attempt.stop-reason-recovery.js";

const anthropicModel = {
  api: "anthropic-messages",
  provider: "anthropic",
  id: "claude-sonnet-4-6",
} as Model<"anthropic-messages">;

describe("wrapStreamFnHandleSensitiveStopReason", () => {
  it("rewrites unhandled stop-reason errors into structured assistant errors", async () => {
    const baseStreamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            api: anthropicModel.api,
            provider: anthropicModel.provider,
            model: anthropicModel.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: "Unhandled stop reason: sensitive",
            timestamp: Date.now(),
          },
        });
        stream.end();
      });
      return stream;
    };

    const wrapped = wrapStreamFnHandleSensitiveStopReason(baseStreamFn);
    const stream = await Promise.resolve(
      wrapped(anthropicModel, { messages: [] } as Context, undefined),
    );
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "The model stopped because the provider returned an unhandled stop reason: sensitive. Please rephrase and try again.",
    );
  });

  it("includes the extracted stop reason when converting synchronous throws", async () => {
    const baseStreamFn: StreamFn = () => {
      throw new Error("Unhandled stop reason: refusal_policy");
    };

    const wrapped = wrapStreamFnHandleSensitiveStopReason(baseStreamFn);
    const stream = await Promise.resolve(
      wrapped(anthropicModel, { messages: [] } as Context, undefined),
    );
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "The model stopped because the provider returned an unhandled stop reason: refusal_policy. Please rephrase and try again.",
    );
  });
});
