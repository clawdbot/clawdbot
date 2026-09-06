import { expect, it, vi } from "vitest";
import {
  createContext,
  createReasoningStreamContext,
  createTelegramDraftStream,
  describeTelegramDispatch,
  dispatchWithContext,
  expectDispatchParams,
  getGlobalHookRunner,
} from "./bot-message-dispatch.test-harness.js";

function registerHooks(...hooks: string[]) {
  const registered = new Set(hooks);
  getGlobalHookRunner.mockReturnValue({
    hasHooks: vi.fn((hookName: string) => registered.has(hookName)),
  });
}

describeTelegramDispatch("Telegram provider preview hook safety", () => {
  it.each([
    {
      label: "streaming is off",
      streamMode: "off",
      telegramCfg: {},
    },
    {
      label: "partial tool progress is off",
      streamMode: "partial",
      telegramCfg: { streaming: { preview: { toolProgress: false } } },
    },
    {
      label: "progress tool progress is off",
      streamMode: "progress",
      telegramCfg: { streaming: { progress: { toolProgress: false } } },
    },
  ] as const)(
    "suppresses standalone tool progress when $label",
    async ({ streamMode, telegramCfg }) => {
      await dispatchWithContext({ context: createContext(), streamMode, telegramCfg });

      expectDispatchParams({
        replyOptions: expect.objectContaining({ suppressToolProgressMessages: true }),
      });
    },
  );

  it("allows verbose progress when progress rendering is enabled", async () => {
    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { progress: { toolProgress: true } } },
    });

    expectDispatchParams({
      replyOptions: expect.objectContaining({ suppressToolProgressMessages: false }),
    });
  });

  it("preserves answer previews when no hooks are registered", async () => {
    await dispatchWithContext({ context: createContext() });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
    expectDispatchParams({
      replyOptions: expect.objectContaining({ disableBlockStreaming: true }),
    });
  });

  it("preserves answer previews for observer-only hooks", async () => {
    registerHooks("message_sent");

    await dispatchWithContext({ context: createContext() });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
  });

  it.each(["reply_payload_sending", "message_sending"])(
    "suppresses answer and progress previews when %s is registered",
    async (hookName) => {
      registerHooks(hookName);

      await dispatchWithContext({ context: createContext(), streamMode: "progress" });

      expect(createTelegramDraftStream).not.toHaveBeenCalled();
      const params = expectDispatchParams({
        replyOptions: expect.objectContaining({
          onPartialReply: undefined,
          disableBlockStreaming: undefined,
        }),
      });
      expect(params.replyOptions).not.toHaveProperty("forceToolResultProgress");
    },
  );

  it("suppresses previews when both modifying hooks are registered", async () => {
    registerHooks("reply_payload_sending", "message_sending");

    await dispatchWithContext({ context: createContext() });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
  });

  it("suppresses the independent reasoning preview when streaming is otherwise off", async () => {
    registerHooks("message_sending");

    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "off" });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
  });

  it("preserves the independent reasoning preview without modifying hooks", async () => {
    await dispatchWithContext({ context: createReasoningStreamContext(), streamMode: "off" });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
  });
});
