import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTelegramSubagentTyping } from "../subagent-typing-api.js";
import { TELEGRAM_CHAT_ACTION_INTERVAL_MS } from "./chat-action-timing.js";

const sendRuntimeMocks = vi.hoisted(() => ({
  sendTypingTelegram: vi.fn(async () => undefined),
}));

vi.mock("./send-runtime.js", () => ({
  loadTelegramSendModule: async () => ({
    sendTypingTelegram: sendRuntimeMocks.sendTypingTelegram,
  }),
}));

describe("Telegram detached-subagent typing integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendRuntimeMocks.sendTypingTelegram.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts, renews, and stops route typing through the plugin hook", async () => {
    let progressHandler: ((event: ReturnType<typeof progressEvent>) => void) | undefined;
    const registerRuntimeLifecycle = vi.fn();
    const api = createTestPluginApi({
      id: "telegram",
      on: ((hookName, handler) => {
        if (hookName === "subagent_progress") {
          progressHandler = handler as (event: ReturnType<typeof progressEvent>) => void;
        }
      }) as OpenClawPluginApi["on"],
      registerRuntimeLifecycle,
    });
    registerTelegramSubagentTyping(api);

    progressHandler?.(progressEvent("started", "run-1"));
    progressHandler?.(progressEvent("started", "run-2"));
    await vi.dynamicImportSettled();
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledTimes(2);

    progressHandler?.(progressEvent("ended", "run-1"));
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledTimes(3);

    progressHandler?.(progressEvent("ended", "run-2"));
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledTimes(3);
    expect(sendRuntimeMocks.sendTypingTelegram).toHaveBeenCalledWith(
      "telegram:group:-100123:topic:7",
      expect.objectContaining({ accountId: "work", messageThreadId: 7 }),
    );

    const lifecycle = registerRuntimeLifecycle.mock.calls[0]?.[0] as {
      cleanup: () => Promise<void> | void;
    };
    await lifecycle.cleanup();
  });
});

function progressEvent(phase: "started" | "ended", runId: string) {
  return {
    phase,
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requester: {
      channel: "telegram",
      accountId: "work",
      to: "telegram:group:-100123:topic:7",
      threadId: 7,
    },
  };
}
