import { describe, expect, it } from "vitest";
import { createStreamingDirectiveAccumulator } from "./streaming-directives.js";

describe("createStreamingDirectiveAccumulator", () => {
  it("stashes reply_to_current until a renderable chunk arrives", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    expect(accumulator.consume("[[reply_to_current]]")).toBeNull();

    const result = accumulator.consume("Hello");
    expect(result?.text).toBe("Hello");
    expect(result?.replyToCurrent).toBe(true);
    expect(result?.replyToTag).toBe(true);
  });

  it("handles reply tags split across chunks", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    expect(accumulator.consume("[[reply_to_")).toBeNull();

    const result = accumulator.consume("current]] Yo");
    expect(result?.text).toBe("Yo");
    expect(result?.replyToCurrent).toBe(true);
    expect(result?.replyToTag).toBe(true);
  });

  it("propagates explicit reply ids across chunks", () => {
    const accumulator = createStreamingDirectiveAccumulator();

    expect(accumulator.consume("[[reply_to: abc-123]]")).toBeNull();

    const result = accumulator.consume("Hi");
    expect(result?.text).toBe("Hi");
    expect(result?.replyToId).toBe("abc-123");
    expect(result?.replyToTag).toBe(true);
  });
});
