// Telegram tests cover detached-subagent typing lifecycle behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_CHAT_ACTION_INTERVAL_MS,
  TELEGRAM_SUBAGENT_TYPING_MAX_DURATION_MS,
} from "./chat-action-timing.js";
import { createTelegramSubagentTyping } from "./subagent-typing.js";

function createController() {
  const sendTyping = vi.fn(async () => undefined);
  const onTypingError = vi.fn();
  const controller = createTelegramSubagentTyping({ sendTyping, onTypingError });
  return { controller, sendTyping };
}

function startEvent(
  runId: string,
  requester: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  },
) {
  return {
    phase: "started" as const,
    runId,
    requester,
  };
}

async function flushTypingStart(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Telegram detached-subagent typing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps one route typing until its last concurrent child ends", async () => {
    const { controller, sendTyping } = createController();
    const requester = {
      channel: "telegram",
      accountId: "work",
      to: "telegram:group:-100123:topic:7",
      threadId: 7,
    };

    controller.handle(startEvent("run-1", requester));
    controller.handle(startEvent("run-1", requester));
    controller.handle(startEvent("run-2", requester));
    await flushTypingStart();
    expect(sendTyping).toHaveBeenCalledOnce();

    controller.handle({ phase: "ended", runId: "run-1" });
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    controller.handle({ phase: "ended", runId: "run-2" });
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);
    expect(sendTyping).toHaveBeenCalledTimes(2);
  });

  it("isolates typing by account, chat, and topic", async () => {
    const { controller, sendTyping } = createController();

    controller.handle(
      startEvent("run-work", {
        channel: "telegram",
        accountId: "work",
        to: "-100123",
        threadId: 7,
      }),
    );
    controller.handle(
      startEvent("run-ops", {
        channel: "telegram",
        accountId: "ops",
        to: "-100123",
        threadId: 7,
      }),
    );
    controller.handle(
      startEvent("run-topic", {
        channel: "telegram",
        accountId: "work",
        to: "-100123",
        threadId: "8",
      }),
    );
    await flushTypingStart();

    expect(sendTyping).toHaveBeenCalledTimes(3);
    expect(sendTyping).toHaveBeenCalledWith({ accountId: "work", to: "-100123", threadId: 7 });
    expect(sendTyping).toHaveBeenCalledWith({ accountId: "ops", to: "-100123", threadId: 7 });
    expect(sendTyping).toHaveBeenCalledWith({
      accountId: "work",
      to: "-100123",
      threadId: "8",
    });
  });

  it("expires a run whose terminal event never arrives", async () => {
    const { controller, sendTyping } = createController();
    controller.handle(startEvent("lost-run", { channel: "telegram", to: "42" }));
    await flushTypingStart();

    await vi.advanceTimersByTimeAsync(TELEGRAM_SUBAGENT_TYPING_MAX_DURATION_MS);
    const callsAtExpiry = sendTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);

    expect(callsAtExpiry).toBeGreaterThan(1);
    expect(sendTyping).toHaveBeenCalledTimes(callsAtExpiry);
  });

  it("ignores progress without a routable Telegram requester", async () => {
    const { controller, sendTyping } = createController();

    controller.handle(startEvent("discord-run", { channel: "discord", to: "42" }));
    controller.handle(startEvent("missing-target", { channel: "telegram" }));
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);

    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("ignores channel Direct Messages because Telegram does not support typing there", async () => {
    const { controller, sendTyping } = createController();

    controller.handle(
      startEvent("direct-topic-run", {
        channel: "telegram",
        to: "telegram:group:-100123:direct-topic:77",
      }),
    );
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);

    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("stops all route timers when the plugin runtime is disposed", async () => {
    const { controller, sendTyping } = createController();
    controller.handle(startEvent("run-1", { channel: "telegram", to: "42" }));
    await flushTypingStart();
    expect(sendTyping).toHaveBeenCalledOnce();

    controller.dispose();
    await vi.advanceTimersByTimeAsync(TELEGRAM_CHAT_ACTION_INTERVAL_MS);

    expect(sendTyping).toHaveBeenCalledOnce();
  });
});
