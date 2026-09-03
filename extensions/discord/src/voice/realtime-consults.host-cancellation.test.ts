import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

type AgentResult = { payloads: Array<{ text: string }> };

const cancelledResult = {
  status: "cancelled",
  message: "OpenClaw cancelled this consult before completion. Do not restart it.",
};

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    agentCommandMock,
    loggerWarnMock,
    realtimeSessionMock,
    beginSpeakerTurn,
    agentCommandArgsAt,
    createJoinedAgentProxyFixture,
    createJoinedBidiFixture,
    emitFinalRealtimeUserTranscript,
    flushRealtimeForcedConsultTimers,
    getSessionEntry,
    lastRealtimeBridgeParams,
  }) => {
    const drainConsultWork = () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

    async function createPendingConsultFixture(mode: "bidi" | "agent-proxy" = "agent-proxy") {
      const hostTurn = createDeferred<AgentResult>();
      agentCommandMock.mockReturnValueOnce(hostTurn.promise);
      const fixture =
        mode === "bidi"
          ? await createJoinedBidiFixture({ voice: { realtime: { consultPolicy: "always" } } })
          : await createJoinedAgentProxyFixture();
      const submissions: Array<Promise<PromiseSettledResult<void>>> = [];
      const consult = (callId: string, bridgeParams = fixture.bridgeParams) => {
        const submission = Promise.resolve(
          bridgeParams.onToolCall!(
            {
              itemId: `item-${callId}`,
              callId,
              name: "openclaw_agent_consult",
              args: { question: "shared question" },
            },
            realtimeSessionMock,
          ),
        ).then(
          (): PromiseFulfilledResult<void> => ({ status: "fulfilled", value: undefined }),
          (reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }),
        );
        submissions.push(submission);
        return submission;
      };
      return {
        ...fixture,
        hostTurn,
        consult,
        async close() {
          fixture.entry.stop();
          hostTurn.resolve({ payloads: [] });
          await Promise.all(submissions);
          // Forced consult timers launch work without returning its promise. Drain its
          // rejection/delivery continuations before the shared mocks are reset.
          await drainConsultWork();
          await fixture.manager.destroy();
        },
      };
    }

    it.each([
      { mode: "bidi", path: "native", abort: "signal", suppression: true, rejectDelivery: false },
      {
        mode: "agent-proxy",
        path: "native",
        abort: "named",
        suppression: false,
        rejectDelivery: false,
      },
      {
        mode: "agent-proxy",
        path: "late",
        abort: "signal",
        suppression: true,
        rejectDelivery: false,
      },
      {
        mode: "agent-proxy",
        path: "joined",
        abort: "signal",
        suppression: true,
        rejectDelivery: false,
      },
      {
        mode: "agent-proxy",
        path: "joined",
        abort: "named",
        suppression: false,
        rejectDelivery: false,
      },
      {
        mode: "agent-proxy",
        path: "joined",
        abort: "named",
        suppression: false,
        rejectDelivery: true,
      },
    ] as const)(
      "terminally cancels $mode $path host $abort abort (suppression=$suppression, delivery rejection=$rejectDelivery)",
      async ({ mode, path, abort, suppression, rejectDelivery }) => {
        const fixture = await createPendingConsultFixture(mode);
        const { bridgeParams, entry, hostTurn, consult } = fixture;
        const deliveryError = new Error("native delivery rejected");
        const pending: Array<ReturnType<typeof consult>> = [];
        const callIds: string[] = [];
        realtimeSessionMock.bridge.supportsToolResultSuppression = suppression;
        try {
          beginSpeakerTurn(entry, { extraSystemPrompt: "owner context" });
          if (path === "native") {
            callIds.push("call-native", "call-joined");
            pending.push(consult("call-native"), consult("call-joined"));
          } else {
            await emitFinalRealtimeUserTranscript(bridgeParams, "shared question");
            if (path === "joined") {
              callIds.push("call-joined");
              pending.push(consult("call-joined"));
            }
          }
          await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));
          expect(agentCommandArgsAt(0)).toMatchObject({
            senderIsOwner: true,
            extraSystemPrompt: "owner context",
          });
          if (rejectDelivery) {
            realtimeSessionMock.submitToolResult.mockRejectedValueOnce(deliveryError);
          }
          hostTurn.reject(
            abort === "signal"
              ? AbortSignal.abort().reason
              : Object.assign(new Error("host turn cancelled"), { name: "AbortError" }),
          );
          const outcomes = await Promise.all(pending);
          expect(outcomes).toEqual(
            pending.map(() =>
              rejectDelivery
                ? { status: "rejected", reason: deliveryError }
                : { status: "fulfilled", value: undefined },
            ),
          );
          await drainConsultWork();

          // The provider stays connected: host cancellation must not request error speech.
          expect.soft(entry.realtimeLifecycle.status).toBe("active");
          expect.soft(realtimeSessionMock.close).not.toHaveBeenCalled();
          expect.soft(realtimeSessionMock.sendUserMessage).not.toHaveBeenCalled();
          expect.soft(loggerWarnMock).not.toHaveBeenCalled();

          callIds.push("call-late", "call-deduped");
          await consult("call-late");
          await consult("call-deduped");
          expect.soft(agentCommandMock).toHaveBeenCalledTimes(1);
          expect
            .soft(realtimeSessionMock.submitToolResult.mock.calls)
            .toEqual(
              callIds.map((callId) =>
                suppression
                  ? [callId, cancelledResult, { suppressResponse: true }]
                  : [callId, cancelledResult],
              ),
            );
          expect.soft(realtimeSessionMock.sendUserMessage).not.toHaveBeenCalled();
          expect.soft(loggerWarnMock).not.toHaveBeenCalled();

          if (path === "late") {
            agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "guest answer" }] });
            beginSpeakerTurn(entry, { senderIsOwner: false, extraSystemPrompt: "guest context" });
            await flushRealtimeForcedConsultTimers(async () => {
              bridgeParams.onTranscript?.("user", "shared question", true);
              await consult("call-guest");
            });
            expect(agentCommandMock).toHaveBeenCalledTimes(2);
            expect(agentCommandArgsAt(1)).toMatchObject({
              senderIsOwner: false,
              extraSystemPrompt: "guest context",
            });
            expect(realtimeSessionMock.submitToolResult.mock.calls.at(-1)).toEqual([
              "call-guest",
              { text: "guest answer" },
            ]);
          }
        } finally {
          await fixture.close();
        }
      },
    );

    it.each(["success", "failure"] as const)(
      "waits for every native delivery before handing forced %s playback back",
      async (outcome) => {
        const fixture = await createPendingConsultFixture();
        const { bridgeParams, entry, hostTurn, consult } = fixture;
        const firstDelivery = createDeferred<void>();
        const deliveryError = Object.assign(new Error("provider delivery aborted"), {
          name: "AbortError",
        });
        realtimeSessionMock.bridge.supportsToolResultSuppression = false;
        try {
          beginSpeakerTurn(entry);
          await emitFinalRealtimeUserTranscript(bridgeParams, "shared question");
          realtimeSessionMock.submitToolResult
            .mockReturnValueOnce(firstDelivery.promise)
            .mockRejectedValueOnce(deliveryError);
          const first = consult("call-first");
          const second = consult("call-second");
          if (outcome === "success") {
            hostTurn.resolve({ payloads: [{ text: "shared answer" }] });
          } else {
            hostTurn.reject(new Error("host failed"));
          }
          expect(await second).toEqual({ status: "rejected", reason: deliveryError });
          await drainConsultWork();
          expect.soft(realtimeSessionMock.sendUserMessage).not.toHaveBeenCalled();

          firstDelivery.resolve();
          expect(await first).toEqual({ status: "fulfilled", value: undefined });
          await drainConsultWork();
          expect(realtimeSessionMock.sendUserMessage).not.toHaveBeenCalled();
          expect(agentCommandMock).toHaveBeenCalledOnce();
          const result =
            outcome === "success" ? { text: "shared answer" } : { error: "host failed" };
          expect(realtimeSessionMock.submitToolResult.mock.calls).toEqual([
            ["call-first", result],
            ["call-second", result],
          ]);
        } finally {
          firstDelivery.resolve();
          await fixture.close();
        }
      },
    );

    it.each([
      { transition: "reset", path: "native" },
      { transition: "reset", path: "joined" },
      { transition: "teardown", path: "native" },
      { transition: "teardown", path: "joined" },
    ] as const)(
      "isolates stale $path host cancellation after $transition from the next speaker's same question",
      async ({ transition, path }) => {
        const fixture = await createPendingConsultFixture();
        const { manager, hostTurn, consult } = fixture;
        let { bridgeParams, entry } = fixture;
        const freshTurn = createDeferred<AgentResult>();
        agentCommandMock.mockReturnValueOnce(freshTurn.promise);
        realtimeSessionMock.bridge.supportsToolResultSuppression = false;
        try {
          beginSpeakerTurn(entry);
          if (path === "joined") {
            await emitFinalRealtimeUserTranscript(bridgeParams, "shared question");
          }
          const oldSubmission = consult("call-old");
          await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));

          if (transition === "teardown") {
            entry.stop();
            await manager.join({ guildId: "g1", channelId: "1001" });
            entry = getSessionEntry(manager);
            bridgeParams = lastRealtimeBridgeParams();
          } else {
            bridgeParams.onEvent?.({ direction: "client", type: "session.continuity.reset" });
            bridgeParams.onReady?.();
          }
          beginSpeakerTurn(entry, { senderIsOwner: false, extraSystemPrompt: "fresh guest" });
          const freshSubmission = consult("call-fresh", bridgeParams);
          await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(2));

          hostTurn.reject(AbortSignal.abort().reason);
          await oldSubmission;
          await drainConsultWork();
          expect(realtimeSessionMock.submitToolResult).not.toHaveBeenCalled();
          expect(realtimeSessionMock.sendUserMessage).not.toHaveBeenCalled();
          expect(loggerWarnMock).not.toHaveBeenCalled();

          freshTurn.resolve({ payloads: [{ text: "fresh answer" }] });
          await freshSubmission;
          await consult("call-fresh-deduped", bridgeParams);
          expect(agentCommandMock).toHaveBeenCalledTimes(2);
          expect(agentCommandArgsAt(1)).toMatchObject({
            senderIsOwner: false,
            extraSystemPrompt: "fresh guest",
          });
          expect(realtimeSessionMock.submitToolResult.mock.calls).toEqual([
            ["call-fresh", { text: "fresh answer" }],
            ["call-fresh-deduped", { text: "fresh answer" }],
          ]);
          expect(realtimeSessionMock.sendUserMessage).not.toHaveBeenCalled();
          expect(loggerWarnMock).not.toHaveBeenCalled();
        } finally {
          freshTurn.resolve({ payloads: [] });
          await fixture.close();
        }
      },
    );
  },
);
