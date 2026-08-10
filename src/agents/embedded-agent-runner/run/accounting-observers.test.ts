import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../../../llm/types.js";
import type { StreamFn } from "../../runtime/index.js";
import { wrapStreamFnWithModelCallAccounting } from "./accounting-observers.js";

function assistant(stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

function streamWithResult(result: AssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {},
    result: async () => result,
  };
}

describe("model call accounting", () => {
  it.each([
    ["stop", "completed"],
    ["error", "failed"],
    ["aborted", "failed"],
  ] as const)("settles an admitted %s call as %s", async (stopReason, outcome) => {
    const settle = vi.fn();
    const observer = vi.fn(() => ({ settle }));
    const source = vi.fn(() => streamWithResult(assistant(stopReason))) as unknown as StreamFn;
    const wrapped = wrapStreamFnWithModelCallAccounting(source, observer);

    const stream = await wrapped({} as never, {} as never);
    expect(settle).not.toHaveBeenCalled();
    await stream.result();
    await stream.result();

    expect(settle).toHaveBeenCalledExactlyOnceWith(outcome);
    expect(observer).toHaveBeenCalledOnce();
    expect(source).toHaveBeenCalledOnce();
  });

  it("settles a rejected result once without eagerly reading it", async () => {
    const error = new Error("result failed");
    const result = vi.fn(async () => {
      throw error;
    });
    const settle = vi.fn();
    const wrapped = wrapStreamFnWithModelCallAccounting(
      vi.fn(() => ({
        async *[Symbol.asyncIterator]() {},
        result,
      })) as unknown as StreamFn,
      () => ({ settle }),
    );

    const stream = await wrapped({} as never, {} as never);
    expect(result).not.toHaveBeenCalled();
    await expect(stream.result()).rejects.toBe(error);

    expect(result).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledExactlyOnceWith("failed");
  });

  it("settles an iterator failure even when result is never read", async () => {
    const error = new Error("stream failed");
    const result = vi.fn(async () => assistant("error"));
    const settle = vi.fn();
    const wrapped = wrapStreamFnWithModelCallAccounting(
      vi.fn(() => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw error;
            },
          };
        },
        result,
      })) as unknown as StreamFn,
      () => ({ settle }),
    );

    const stream = await wrapped({} as never, {} as never);
    await expect(
      (async () => {
        for await (const event of stream) {
          void event;
        }
      })(),
    ).rejects.toBe(error);

    expect(result).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledExactlyOnceWith("failed");
  });

  it("does not invent a call when the outer pre-dispatch guard bypasses admission", () => {
    const observer = vi.fn(() => ({ settle: vi.fn() }));
    const admitted = wrapStreamFnWithModelCallAccounting(vi.fn() as never, observer);
    const bypassed = true;
    const guarded = () =>
      bypassed ? streamWithResult(assistant("aborted")) : admitted({} as never, {} as never);

    guarded();

    expect(observer).not.toHaveBeenCalled();
  });
});
