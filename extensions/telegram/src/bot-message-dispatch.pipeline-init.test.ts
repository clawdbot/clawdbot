import { expect, it, vi } from "vitest";
import {
  createChannelMessageReplyPipeline,
  createContext,
  createRuntime,
  createStatusReactionController,
  dispatchReplyWithBufferedBlockDispatcher,
  describeTelegramDispatch,
  dispatchWithContext,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";
import { telegramInboundEventDelivery } from "./inbound-event-delivery.js";

describeTelegramDispatch("dispatchTelegramMessage pipeline-init", () => {
  it("keeps the owning Gateway reply dispatcher on the assembled inbound turn", async () => {
    const dispatchReplyFromConfig = vi.fn();

    await dispatchWithContext({
      context: createContext(),
      opts: {
        token: "token",
        dispatchReplyFromConfig,
      } as Parameters<typeof dispatchWithContext>[0]["opts"],
    });

    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchReplyFromConfig }),
    );
  });

  it("does not enter the reply pipeline after the durable owner aborts", async () => {
    const abortController = new AbortController();
    abortController.abort(new Error("handler-timeout"));

    await expect(
      dispatchWithContext({
        context: createContext(),
        turnAdoptionLifecycle: {
          abortSignal: abortController.signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onAbandoned: vi.fn(),
        },
      }),
    ).resolves.toEqual({ kind: "completed" });

    expect(createChannelMessageReplyPipeline).not.toHaveBeenCalled();
  });

  it("keeps Telegram typing below its client expiry without a per-message cutoff", async () => {
    await dispatchWithContext({ context: createContext() });

    expect(createChannelMessageReplyPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        typing: expect.objectContaining({
          keepaliveIntervalMs: 4_000,
          maxDurationMs: 0,
        }),
      }),
    );
  });

  it("cleans delivery correlation when reply-pipeline initialization fails", async () => {
    const sessionKey = "agent:main:telegram:direct:pipeline-init-failure";
    const statusReactionController = createStatusReactionController();
    const reactionApi = vi.fn(async () => undefined);
    const runtime = createRuntime();
    runtime.error = vi.fn(() => {
      telegramInboundEventDelivery.notify({
        sessionKey,
        to: "123",
        accountId: "default",
      });
    });
    createChannelMessageReplyPipeline.mockImplementationOnce(() => {
      throw new Error("pipeline initialization failed");
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: sessionKey,
          ChatType: "direct",
        } as TelegramMessageContext["ctxPayload"],
        statusReactionController: statusReactionController as never,
        reactionApi,
      }),
      runtime,
      suppressFailureFallback: true,
    });

    await vi.waitFor(() => {
      expect(statusReactionController.restoreInitial).toHaveBeenCalled();
    });
    expect(reactionApi).not.toHaveBeenCalled();
  });
});
