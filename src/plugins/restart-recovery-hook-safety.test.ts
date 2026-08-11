import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeGlobalHookRunner, resetGlobalHookRunner } from "./hook-runner-global.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
import { findRestartRecoveryUnsafeChatAdmissionHook } from "./restart-recovery-hook-safety.js";

afterEach(() => {
  resetGlobalHookRunner();
});

describe("findRestartRecoveryUnsafeChatAdmissionHook", () => {
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
