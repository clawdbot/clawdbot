import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findRestartRecoveryUnsafeChatAdmissionHook,
  findRestartRecoveryUnsafeReplyHook,
} from "./restart-recovery-hook-safety.js";

const hookMocks = vi.hoisted(() => ({
  hasGlobalHooks: vi.fn<(hookName: string) => boolean>(),
}));

vi.mock("./hook-runner-global.js", () => ({
  hasGlobalHooks: hookMocks.hasGlobalHooks,
}));

describe("findRestartRecoveryUnsafeReplyHook", () => {
  beforeEach(() => {
    hookMocks.hasGlobalHooks.mockReset();
    hookMocks.hasGlobalHooks.mockReturnValue(false);
  });

  it("reports the first active unsafe reply hook", () => {
    hookMocks.hasGlobalHooks.mockImplementation(
      (hookName) => hookName === "before_agent_reply" || hookName === "before_message_write",
    );

    expect(findRestartRecoveryUnsafeReplyHook()).toBe("before_agent_reply");
  });

  it("does not exempt a checkpointed hook without a cross-process implementation digest", () => {
    hookMocks.hasGlobalHooks.mockImplementation(
      (hookName) => hookName === "before_agent_reply" || hookName === "before_message_write",
    );

    expect(findRestartRecoveryUnsafeReplyHook()).toBe("before_agent_reply");
  });

  it("allows deferred before_agent_reply at initial durable chat admission", () => {
    hookMocks.hasGlobalHooks.mockImplementation(
      (hookName) => hookName === "before_agent_reply" || hookName === "before_message_write",
    );

    expect(findRestartRecoveryUnsafeChatAdmissionHook()).toBe("before_message_write");
  });
});
