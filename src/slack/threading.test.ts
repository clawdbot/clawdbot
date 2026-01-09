import { describe, expect, it } from "vitest";

import { resolveSlackThreadTargets } from "./threading.js";

describe("resolveSlackThreadTargets", () => {
  it("threads replies when message is already threaded", () => {
    const { replyThreadTs, statusThreadTs } = resolveSlackThreadTargets({
      replyToMode: "off",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
        thread_ts: "456",
      },
    });

    expect(replyThreadTs).toBe("456");
    expect(statusThreadTs).toBe("456");
  });

  it("threads top-level replies when mode is all", () => {
    const { replyThreadTs, statusThreadTs } = resolveSlackThreadTargets({
      replyToMode: "all",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
      },
    });

    expect(replyThreadTs).toBe("123");
    expect(statusThreadTs).toBe("123");
  });

  it("keeps status threading even when reply threading is off", () => {
    const { replyThreadTs, statusThreadTs } = resolveSlackThreadTargets({
      replyToMode: "off",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
      },
    });

    expect(replyThreadTs).toBeUndefined();
    expect(statusThreadTs).toBe("123");
  });
});
