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
      expectDispatchParams({
        replyOptions: expect.objectContaining({
          onPartialReply: undefined,
          disableBlockStreaming: undefined,
        }),
      });
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
