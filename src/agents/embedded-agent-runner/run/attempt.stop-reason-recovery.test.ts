// Coverage for converting sensitive/unhandled stop reasons into assistant errors.
import { withRunFailureOrigin } from "@openclaw/llm-core/diagnostics";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { wrapStreamFnHandleSensitiveStopReason } from "./attempt-stop-reason-recovery.js";

const anthropicModel = {
  api: "anthropic-messages",
  provider: "anthropic",
  id: "claude-sonnet-4-6",
} as Model<"anthropic-messages">;

describe("wrapStreamFnHandleSensitiveStopReason", () => {
  it("rewrites unhandled stop-reason errors into structured assistant errors", async () => {
    // Some providers surface unhandled stop reasons as stream errors; convert
    // them into a normal assistant error so fallback/retry paths can inspect it.
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
    expect(result.diagnostics).toBeUndefined();
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
    expect(result.diagnostics).toBeUndefined();
  });

  it.each(["sync creation", "async creation", "iterator", "result", "signal replacement"])(
    "preserves runtime origin when recovering %s",
    async (boundary) => {
      const cause = new Error("Unhandled stop reason: runtime_callback");
      const marked = withRunFailureOrigin(cause, "runtime");
      const failure = boundary === "signal replacement" ? cause : marked;
      const signal = boundary === "signal replacement" ? AbortSignal.abort(marked) : undefined;
      const baseStreamFn: StreamFn = () => {
        if (boundary === "async creation") {
          return Promise.reject(failure);
        }
        if (boundary === "sync creation" || boundary === "signal replacement") {
          throw failure;
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield* [];
            if (boundary === "iterator") {
              throw failure;
            }
          },
          result: async () => {
            throw failure;
          },
        };
      };
      const stream = await wrapStreamFnHandleSensitiveStopReason(baseStreamFn)(
        anthropicModel,
        { messages: [] },
        { signal },
      );
      const messages: AssistantMessage[] = [];
      for await (const event of stream) {
        expect(event.type).toBe("error");
        if (event.type === "error") {
          messages.push(event.error);
        }
      }
      messages.push(await stream.result());
      expect(messages).toHaveLength(boundary === "result" ? 1 : 2);
      for (const message of messages) {
        expect(message).toMatchObject({
          stopReason: "error",
          diagnostics: [{ type: "synthesized_run_failure", timestamp: expect.any(Number) }],
        });
      }
    },
  );
});
