// Telegram tests cover detached-subagent hook wiring behavior.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerTelegramSubagentTyping } from "../subagent-typing-api.js";

const controllerMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  dispose: vi.fn(),
  create: vi.fn(),
}));

vi.mock("./subagent-typing.js", () => ({
  createTelegramSubagentTyping: controllerMocks.create,
}));

describe("Telegram detached-subagent hook wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controllerMocks.create.mockReturnValue({
      handle: controllerMocks.handle,
      dispose: controllerMocks.dispose,
    });
  });

  it("returns immediately and cleans up the lazily created controller", async () => {
    let progressHandler: ((event: unknown, context: unknown) => unknown) | undefined;
    const registerRuntimeLifecycle = vi.fn();
    const api = createTestPluginApi({
      id: "telegram",
      on: ((hookName, handler) => {
        if (hookName === "subagent_progress") {
          progressHandler = handler as (event: unknown, context: unknown) => unknown;
        }
      }) as OpenClawPluginApi["on"],
      registerRuntimeLifecycle,
    });
    registerTelegramSubagentTyping(api);
    const event = startEventForTest();

    expect(progressHandler?.(event, {})).toBeUndefined();
    await vi.waitFor(() => expect(controllerMocks.handle).toHaveBeenCalledWith(event));

    const lifecycle = registerRuntimeLifecycle.mock.calls[0]?.[0] as {
      cleanup: () => Promise<void> | void;
    };
    await lifecycle.cleanup();
    expect(controllerMocks.dispose).toHaveBeenCalledOnce();
  });
});

function startEventForTest() {
  return {
    phase: "started" as const,
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requester: { channel: "telegram", to: "42" },
  };
}
