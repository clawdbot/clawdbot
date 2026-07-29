import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
import {
  findRestartRecoveryUnsafeChatAdmissionHook,
  findRestartRecoveryUnsafeReplyHook,
} from "./restart-recovery-hook-safety.js";

afterEach(() => {
  resetGlobalHookRunner();
});

describe("findRestartRecoveryUnsafeReplyHook", () => {
  it("reports the first active unsafe reply hook", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_reply", handler: vi.fn() },
        { hookName: "before_message_write", handler: vi.fn() },
      ]),
    );

    expect(findRestartRecoveryUnsafeReplyHook({ trigger: "user" })).toBe("before_agent_reply");
  });

  it("does not exempt a checkpointed hook without a cross-process implementation digest", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_reply", handler: vi.fn() },
        { hookName: "before_message_write", handler: vi.fn() },
      ]),
    );

    expect(findRestartRecoveryUnsafeReplyHook({ trigger: "user" })).toBe("before_agent_reply");
  });

  it("reloads scheduled reply hooks safely across three restart cycles", () => {
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      resetGlobalHookRunner();
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_agent_reply",
            handler: vi.fn(),
            eligibleTriggers: ["heartbeat", "cron"],
          },
        ]),
      );

      expect(findRestartRecoveryUnsafeReplyHook({ trigger: "user" }), `cycle ${cycle}`).toBe(
        undefined,
      );
      expect(findRestartRecoveryUnsafeReplyHook({ trigger: "heartbeat" }), `cycle ${cycle}`).toBe(
        "before_agent_reply",
      );
    }
  });

  it("allows deferred before_agent_reply at initial durable chat admission", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_agent_reply", handler: vi.fn() },
        { hookName: "before_message_write", handler: vi.fn() },
      ]),
    );

    expect(findRestartRecoveryUnsafeChatAdmissionHook()).toBe("before_message_write");
  });
});
