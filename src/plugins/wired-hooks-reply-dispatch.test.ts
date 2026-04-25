import { describe, expect, it, vi } from "vitest";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import { createHookRunnerWithRegistry } from "./hooks.test-helpers.js";

const replyDispatchEvent = {
  ctx: buildTestCtx({ SessionKey: "agent:test:session", BodyForAgent: "hello" }),
  sessionKey: "agent:test:session",
  inboundAudio: false,
  shouldRouteToOriginating: false,
  shouldSendToolSummaries: true,
  sendPolicy: "allow" as const,
};

const replyDispatchCtx = {
  cfg: {},
  dispatcher: {
    sendToolResult: () => false,
    sendBlockReply: () => false,
    sendFinalReply: () => false,
    waitForIdle: async () => {},
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {},
  },
  recordProcessed: () => {},
  markIdle: () => {},
};

describe("reply_dispatch hook runner", () => {
  it("stops at the first handler that claims reply dispatch", async () => {
    const first = vi.fn().mockResolvedValue({
      handled: true,
      queuedFinal: true,
      counts: { tool: 0, block: 1, final: 1 },
    });
    const second = vi.fn().mockResolvedValue({
      handled: true,
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "reply_dispatch", handler: first },
      { hookName: "reply_dispatch", handler: second },
    ]);

    const result = await runner.runReplyDispatch(replyDispatchEvent, replyDispatchCtx);

    expect(result).toEqual({
      handled: true,
      queuedFinal: true,
      counts: { tool: 0, block: 1, final: 1 },
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("continues to the next handler when a higher-priority handler throws", async () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const succeeding = vi.fn().mockResolvedValue({
      handled: true,
      queuedFinal: false,
      counts: { tool: 1, block: 0, final: 0 },
    });
    const { runner } = createHookRunnerWithRegistry(
      [
        { hookName: "reply_dispatch", handler: failing },
        { hookName: "reply_dispatch", handler: succeeding },
      ],
      { logger },
    );

    const result = await runner.runReplyDispatch(replyDispatchEvent, replyDispatchCtx);

    expect(result).toEqual({
      handled: true,
      queuedFinal: false,
      counts: { tool: 1, block: 0, final: 0 },
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("reply_dispatch handler from test-plugin failed: boom"),
    );
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});
