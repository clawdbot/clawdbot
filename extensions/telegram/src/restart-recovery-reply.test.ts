import { expect, it, vi } from "vitest";
import {
  describeTelegramDispatch,
  createBot,
  setupDraftStreams,
  dispatchReplyWithBufferedBlockDispatcher,
  createTelegramDraftStream,
  deliverReplies,
  mockCallArg,
} from "./bot-message-dispatch.test-harness.js";
import { dispatchTelegramRecoveryReply } from "./restart-recovery-reply.js";

vi.mock("./send-context.js", () => ({
  withTelegramApiContext: async (
    params: { cfg: unknown; accountId?: string },
    run: (ctx: unknown) => Promise<void>,
  ) =>
    run({
      api: createBot().api,
      account: {
        accountId: params.accountId ?? "default",
        token: "123:test",
        config: { streaming: { mode: "partial" } },
      },
    }),
}));

describeTelegramDispatch("restart recovery Telegram presentation", () => {
  it.each([
    { to: "-100123", threadId: "42", expectedThread: 42 },
    { to: "123:topic:77", threadId: undefined, expectedThread: 77 },
  ])(
    "streams tools and final text into the recovered conversation $to",
    async ({ to, threadId, expectedThread }) => {
      const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          replyOptions?.onVerboseProgressVisibility?.(() => true);
          await replyOptions?.onToolStart?.({
            name: "read",
            phase: "start",
            args: { path: "README.md" },
          });
          await replyOptions?.onPartialReply?.({ text: "Working on the reply" });
          await dispatcherOptions.deliver(
            { text: "Finished the interrupted response" },
            { kind: "final" },
          );
          return { queuedFinal: true };
        },
      );
      await dispatchTelegramRecoveryReply({
        cfg: {},
        agentId: "default",
        accountId: "work",
        sessionKey: to.startsWith("-")
          ? "agent:default:telegram:group:-100123:topic:42"
          : "agent:default:telegram:direct:123:thread:77",
        sessionId: "session",
        to,
        threadId,
        dispatchReplyFromConfig: vi.fn(),
      });
      expect(mockCallArg(createTelegramDraftStream)).toMatchObject({
        chatId: Number(to.split(":")[0]),
      });
      expect(answerDraftStream.updatePreview).toHaveBeenCalled();
      expect(answerDraftStream.update).toHaveBeenCalledWith(
        "Finished the interrupted response",
        expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
      );
      expect(deliverReplies).not.toHaveBeenCalled();
      const draft = mockCallArg(createTelegramDraftStream) as { thread?: { id?: number } };
      expect(draft.thread?.id).toBe(expectedThread);
    },
  );
});
