import { describe, expect, it, vi } from "vitest";
import { fireAndForgetBoundedHook, fireAndForgetHook } from "./fire-and-forget.js";

function requireFirstLog(logger: ReturnType<typeof vi.fn>): string {
  const [call] = logger.mock.calls;
  if (!call) {
    throw new Error("expected log call");
  }
  const [message] = call;
  if (typeof message !== "string") {
    throw new Error("expected string log message");
  }
  return message;
}

describe("fireAndForgetHook", () => {
  it("logs rejection errors as sanitized single-line messages", async () => {
    const logger = vi.fn();
    fireAndForgetHook(
      Promise.reject(new Error("boom\nforged\tsecret sk-test1234567890")),
      "hook failed",
      logger,
    );
    await Promise.resolve();
    expect(logger).toHaveBeenCalledWith("hook failed: boom forged secret ***");
    const message = requireFirstLog(logger);
    expect(message).not.toContain("\n");
    expect(message).not.toContain("sk-test1234567890");
  });

  it("does not log for resolved tasks", async () => {
    const logger = vi.fn();
    fireAndForgetHook(Promise.resolve("ok"), "hook failed", logger);
    await Promise.resolve();
    expect(logger).not.toHaveBeenCalled();
  });
});

describe("fireAndForgetBoundedHook", () => {
  it("limits queued fire-and-forget hooks", async () => {
    const logger = vi.fn();
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const starts: string[] = [];

    fireAndForgetBoundedHook(
      async () => {
        starts.push("first");
        await first;
      },
      "hook failed",
      logger,
      { maxConcurrency: 1, maxQueue: 1, timeoutMs: 10_000 },
    );
    fireAndForgetBoundedHook(
      async () => {
        starts.push("second");
      },
      "hook failed",
      logger,
      { maxConcurrency: 1, maxQueue: 1, timeoutMs: 10_000 },
    );
    fireAndForgetBoundedHook(
      async () => {
        starts.push("third");
      },
      "hook failed",
      logger,
      { maxConcurrency: 1, maxQueue: 1, timeoutMs: 10_000 },
    );

    await vi.waitFor(() => {
      expect(starts).toEqual(["first"]);
    });
    expect(logger).toHaveBeenCalledWith("hook failed: queue full; dropping hook");

    resolveFirst?.();
    await vi.waitFor(() => {
      expect(starts).toEqual(["first", "second"]);
    });
  });
});
