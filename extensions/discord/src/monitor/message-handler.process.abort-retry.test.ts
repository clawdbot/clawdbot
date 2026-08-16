// Discord message processing coverage split by cohesive behavior.
import { describe, expect, it, vi } from "vitest";
import {
  BASE_CHANNEL_ROUTE,
  createAutomaticSourceDeliveryContext,
  createBaseContext,
  createNoQueuedDispatchResult,
  deliverDiscordReply,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  formatDiscordReplySkip,
  getLastDispatchCtx,
  logVerboseForTest as logVerbose,
  recordInboundSessionForTest as recordInboundSession,
  runProcessDiscordMessage,
  sleepWithAbortForTest as sleepWithAbort,
  registerDiscordProcessTestLifecycle,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";
import { expectFreshFinalText, getReactionEmojis } from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

describe("processDiscordMessage deliver-lambda abort logging", () => {
  it("emits logVerbose with formatDiscordReplySkip when deliver fires on a pre-aborted signal", async () => {
    // Capture logVerbose calls via the ESM namespace binding. We rely on the
    // same vi.spyOn pattern used in native-command.model-picker.test.ts so the
    // production module keeps its real logVerbose import while the test still
    // sees every invocation that the deliver lambda surfaces.
    const verboseSpy = vi.mocked(logVerbose).mockImplementation(() => {});

    const abortController = new AbortController();
    // Drive the dispatcher so deliver actually runs: abort the signal inside
    // the dispatch mock and then queue a single block reply via the captured
    // dispatcher. The mocked createReplyDispatcherWithTyping (see line ~229)
    // routes sendBlockReply straight into the deliver lambda, where the very
    // first gate is `if (isProcessAborted(abortSignal)) return;` — the line
    // the PR added the logVerbose call to.
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      abortController.abort();
      await params?.dispatcher.sendBlockReply({ text: "post-abort block payload" });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 1 } };
    });

    const ctx = await createAutomaticSourceDeliveryContext({
      abortSignal: abortController.signal,
      cfg: {
        messages: {
          ackReaction: "👀",
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    await runProcessDiscordMessage(ctx);

    // The base test harness routes through guild g1 / channel c1 (see
    // createBaseDiscordMessageContext) so the deliver lambda receives the
    // matching deliver target and session key from ctxPayload.SessionKey.
    const dispatchedSessionKey = getLastDispatchCtx()?.SessionKey;
    expect(dispatchedSessionKey).toBeTypeOf("string");
    const expectedLog = formatDiscordReplySkip({
      kind: "block",
      reason: "aborted before delivery",
      target: "channel:c1",
      sessionKey: dispatchedSessionKey,
    });
    const verboseCalls = verboseSpy.mock.calls.map((call) => call[0]);
    expect(verboseCalls).toContain(expectedLog);
    // Restore so other tests sharing this worker (isolate=false) keep the
    // real logVerbose binding.
    verboseSpy.mockRestore();
  });
});

describe("processDiscordMessage reply session init conflict retry", () => {
  const conflictError = () =>
    new Error("reply session initialization conflicted for agent:main:discord:channel:c1");

  it("retries only dispatch while recording, acknowledging, and adding history once", async () => {
    const sleepSpy = vi.mocked(sleepWithAbort).mockResolvedValue(undefined);
    dispatchInboundMessage
      .mockRejectedValueOnce(conflictError())
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce(createNoQueuedDispatchResult());
    const guildHistories = new Map();
    const ctx = await createBaseContext({
      guildHistories,
      historyLimit: 10,
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      inboundEventKind: "room_event",
      ackReactionScope: "all",
      cfg: {
        messages: {
          ackReaction: "👀",
          ackReactionScope: "all",
        },
      },
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 250, undefined);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 1_000, undefined);
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(getReactionEmojis()).toEqual(["👀"]);
    expect(guildHistories.get("c1")).toHaveLength(1);
    expect(guildHistories.get("c1")?.[0]).toMatchObject({
      body: "hi",
      messageId: "m1",
    });
    sleepSpy.mockRestore();
  });

  it("commits replay ownership after a visible terminal failure notice", async () => {
    const sleepSpy = vi.mocked(sleepWithAbort).mockResolvedValue(undefined);
    const originalError = conflictError();
    dispatchInboundMessage.mockRejectedValue(originalError);

    const ctx = await createBaseContext();
    await expect(runProcessDiscordMessage(ctx)).resolves.toBeUndefined();

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(4);
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenNthCalledWith(1, 250, undefined);
    expect(sleepSpy).toHaveBeenNthCalledWith(2, 1_000, undefined);
    expect(sleepSpy).toHaveBeenNthCalledWith(3, 2_500, undefined);
    expectFreshFinalText(
      "⚠️ Couldn't process this message because the session stayed busy. Please try again in a moment.",
    );
    sleepSpy.mockRestore();
  });

  it("keeps exhaustion retryable when the visible failure notice cannot land", async () => {
    const sleepSpy = vi.mocked(sleepWithAbort).mockResolvedValue(undefined);
    const originalError = conflictError();
    dispatchInboundMessage.mockRejectedValue(originalError);
    deliverDiscordReply.mockRejectedValueOnce(new Error("Discord unavailable"));

    const ctx = await createBaseContext();
    let thrown: unknown;
    try {
      await runProcessDiscordMessage(ctx);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ cause: expect.any(Error) });
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(4);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(1);
    sleepSpy.mockRestore();
  });

  it("rebuilds a released replay without duplicating its pending history", async () => {
    const sleepSpy = vi.mocked(sleepWithAbort).mockResolvedValue(undefined);
    dispatchInboundMessage.mockRejectedValue(conflictError());
    deliverDiscordReply.mockRejectedValueOnce(new Error("Discord unavailable"));
    const guildHistories = new Map();
    const createReplayContext = () =>
      createBaseContext({
        guildHistories,
        historyLimit: 10,
        inboundEventKind: "room_event",
      });

    await expect(runProcessDiscordMessage(await createReplayContext())).rejects.toBeInstanceOf(
      Error,
    );
    expect(guildHistories.get("c1")).toHaveLength(1);

    dispatchInboundMessage.mockResolvedValue(createNoQueuedDispatchResult());
    await runProcessDiscordMessage(await createReplayContext());

    expect(getLastDispatchCtx()?.Body).not.toContain("[Chat messages since your last reply");
    expect(guildHistories.get("c1")).toHaveLength(1);
    expect(guildHistories.get("c1")?.[0]?.messageId).toBe("m1");
    sleepSpy.mockRestore();
  });

  it("preserves unrelated dispatch errors", async () => {
    const originalError = new Error("some other dispatch error");
    dispatchInboundMessage.mockRejectedValueOnce(originalError);

    const ctx = await createBaseContext();
    await expect(runProcessDiscordMessage(ctx)).rejects.toBe(originalError);

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("treats an aborted conflict as cancellation", async () => {
    const abortController = new AbortController();
    dispatchInboundMessage.mockImplementationOnce(async () => {
      abortController.abort();
      throw conflictError();
    });

    const ctx = await createBaseContext({ abortSignal: abortController.signal });
    await expect(runProcessDiscordMessage(ctx)).resolves.toBeUndefined();

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });
});
