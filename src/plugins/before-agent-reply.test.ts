import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
  withBeforeAgentReplyObserver,
} from "./before-agent-reply.js";

const hookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn(),
  runBeforeAgentReply: vi.fn(),
}));

vi.mock("./hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunner,
}));

function runHook(runId: string) {
  return runBeforeAgentReplyForTurn({
    runId,
    trigger: "user",
    event: { cleanedBody: runId },
    context: { runId, trigger: "user" },
  });
}

describe("before_agent_reply runner boundary", () => {
  beforeEach(() => {
    hookRunner.hasHooks.mockReset().mockReturnValue(true);
    hookRunner.runBeforeAgentReply.mockReset().mockResolvedValue(undefined);
  });

  it("preserves the complete reply payload", () => {
    const reply = {
      text: "claimed",
      channelData: { native: true },
      sensitiveMedia: true,
      videoAsNote: true,
    };

    expect(buildHandledBeforeAgentReplyPayloads(reply)).toEqual([reply]);
  });

  it("keeps a nested run from checkpointing its parent admission", async () => {
    const beforeDispatch = vi.fn(async () => undefined);
    const afterDispatch = vi.fn(async (result) => result);
    hookRunner.runBeforeAgentReply.mockImplementation(async (_event, context) => {
      if (context.runId === "parent") {
        await runHook("child");
      }
      return undefined;
    });

    await withBeforeAgentReplyObserver({ beforeDispatch, afterDispatch }, () => runHook("parent"));

    expect(hookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(2);
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(afterDispatch).toHaveBeenCalledOnce();
  });
});
