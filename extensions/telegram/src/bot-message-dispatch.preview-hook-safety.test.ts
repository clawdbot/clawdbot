import { expect, it, vi } from "vitest";
import {
  createContext,
  createDirectSessionPayload,
  createReasoningStreamContext,
  createTelegramDraftStream,
  deliverReplies,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  expectDispatchParams,
  getGlobalHookRunner,
  loadSessionStore,
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

  it("inherits the global block default when Telegram only supplies its preview default", async () => {
    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      cfg: { agents: { defaults: { blockStreamingDefault: "on" } } },
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expectDispatchParams({
      replyOptions: expect.objectContaining({
        onPartialReply: undefined,
        disableBlockStreaming: undefined,
      }),
    });
  });

  it("uses a session preview override ahead of Telegram account config", async () => {
    const ctxPayload = createDirectSessionPayload();
    loadSessionStore.mockReturnValue({ [ctxPayload.SessionKey]: { streamingMode: "partial" } });

    await dispatchWithContext({
      context: createContext({ ctxPayload }),
      streamMode: "off",
      cfg: { agents: { defaults: { blockStreamingDefault: "on" } } },
      telegramCfg: { streaming: { mode: "off" } },
    });

    expect(createTelegramDraftStream).toHaveBeenCalledTimes(1);
  });

  it("lets a session turn Telegram previews off without suppressing the turn", async () => {
    const ctxPayload = createDirectSessionPayload();
    loadSessionStore.mockReturnValue({ [ctxPayload.SessionKey]: { streamingMode: "off" } });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({ ctxPayload }),
      streamMode: "partial",
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expectDispatchParams({
      replyOptions: expect.objectContaining({
        onPartialReply: undefined,
        disableBlockStreaming: undefined,
      }),
    });
    expect(deliverReplies).toHaveBeenCalledTimes(1);
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
          forceToolResultProgress: false,
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
