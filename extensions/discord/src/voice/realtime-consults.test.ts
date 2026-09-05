import type { PassThrough } from "node:stream";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createAudioResourceMock,
    resolveAgentRouteMock,
    agentCommandMock,
    loggerWarnMock,
    resolveRealtimeBootstrapContextInstructionsMock,
    realtimeSessionMock,
    beginSpeakerTurn,
    lastRealtimeBridge,
    lastAgentCommandArgs,
    agentCommandArgsAt,
    createJoinedAgentProxyFixture,
    createJoinedBidiFixture,
    lastAudioResourceInput,
    emitFinalRealtimeUserTranscript,
    flushRealtimeForcedConsultTimers,
    expectUserMessageIncludes,
    expectUserMessageNotIncludes,
  }) => {
    it("queues forced agent-proxy answers until current realtime playback idles", async () => {
      let resolveFirst: ((value: { payloads: Array<{ text: string }> }) => void) | undefined;
      let resolveSecond: ((value: { payloads: Array<{ text: string }> }) => void) | undefined;
      let resolveThird: ((value: { payloads: Array<{ text: string }> }) => void) | undefined;
      agentCommandMock
        .mockImplementationOnce(
          () =>
            new Promise<{ payloads: Array<{ text: string }> }>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<{ payloads: Array<{ text: string }> }>((resolve) => {
              resolveSecond = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<{ payloads: Array<{ text: string }> }>((resolve) => {
              resolveThird = resolve;
            }),
        );
      const { bridgeParams, entry, player: rawPlayer } = await createJoinedAgentProxyFixture();
      const player = rawPlayer as {
        on: ReturnType<typeof vi.fn>;
      };

      beginSpeakerTurn(entry);
      beginSpeakerTurn(entry);
      beginSpeakerTurn(entry);
      await flushRealtimeForcedConsultTimers(() => {
        bridgeParams?.onTranscript?.("user", "first question", true);
        bridgeParams?.onTranscript?.("user", "second question", true);
        bridgeParams?.onTranscript?.("user", "third question", true);
      });

      resolveFirst?.({ payloads: [{ text: "first answer" }] });
      await vi.waitFor(() => expectUserMessageIncludes("first answer"));
      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

      resolveSecond?.({ payloads: [{ text: "second answer" }] });
      resolveThird?.({ payloads: [{ text: "third answer" }] });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expectUserMessageNotIncludes("second answer");
      expectUserMessageNotIncludes("third answer");

      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
      const firstStream = lastAudioResourceInput() as PassThrough | undefined;
      await vi.waitFor(() => expect(firstStream?.writableEnded).toBe(true));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expectUserMessageNotIncludes("second answer");

      const idleHandler = player.on.mock.calls.find(([event]) => event === "idle")?.[1] as
        | (() => void)
        | undefined;
      idleHandler?.();
      expectUserMessageIncludes("second answer");
      expectUserMessageNotIncludes("third answer");

      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
      const secondStream = lastAudioResourceInput() as PassThrough | undefined;
      await vi.waitFor(() => expect(secondStream?.writableEnded).toBe(true));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expectUserMessageNotIncludes("third answer");

      idleHandler?.();
      expectUserMessageIncludes("third answer");
    });

    it("isolates a speaker whose retained Unicode speech exceeds the byte budget", async () => {
      const { bridgeParams, entry, manager } = await createJoinedAgentProxyFixture();
      const destroyConnection = vi.spyOn(entry.connection, "destroy");
      const accepted = "😀".repeat(8 * 1024);
      agentCommandMock
        .mockResolvedValueOnce({ payloads: [{ text: accepted }] })
        .mockResolvedValueOnce({ payloads: [{ text: "overflow" }] })
        .mockResolvedValueOnce({ payloads: [{ text: "sibling remains usable" }] });
      try {
        beginSpeakerTurn(entry);
        await emitFinalRealtimeUserTranscript(bridgeParams, "first question");
        expectUserMessageIncludes(accepted);
        beginSpeakerTurn(entry, { senderIsOwner: false });
        const sibling = lastRealtimeBridge();

        await emitFinalRealtimeUserTranscript(bridgeParams, "second question");
        expect(manager.status()).toHaveLength(1);
        expect(destroyConnection).not.toHaveBeenCalled();
        expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
        expect(sibling.session.close).not.toHaveBeenCalled();
        expectUserMessageNotIncludes("overflow");

        await emitFinalRealtimeUserTranscript(sibling.bridgeParams, "guest question");
        expect(agentCommandArgsAt(2).senderIsOwner).toBe(false);
        expect(agentCommandArgsAt(2).message).toContain("guest question");
        // The room notice is already speaking on the surviving lane; its answer queues behind it.
        sibling.bridgeParams.onEvent?.({ direction: "server", type: "response.created" });
        sibling.bridgeParams.onResponseDone?.({ status: "completed" });
        expectUserMessageIncludes("sibling remains usable");

        bridgeParams.onReady?.();
        await emitFinalRealtimeUserTranscript(bridgeParams, "late question");
        expect(agentCommandMock).toHaveBeenCalledTimes(3);
        expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
      } finally {
        await manager.destroy();
      }
    });

    it("retires an overflowing speech lane and admits the speaker again", async () => {
      const { bridgeParams, entry, manager } = await createJoinedAgentProxyFixture();
      const destroyConnection = vi.spyOn(entry.connection, "destroy");
      try {
        beginSpeakerTurn(entry);
        for (let index = 0; index < 32; index += 1) {
          agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: `answer-${index}` }] });
          await emitFinalRealtimeUserTranscript(bridgeParams, `question ${index}`);
        }
        expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledOnce();
        agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "answer-overflow" }] });
        await emitFinalRealtimeUserTranscript(bridgeParams, "overflow question");
        expect(manager.status()).toHaveLength(1);
        expect(destroyConnection).not.toHaveBeenCalled();
        expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
        expectUserMessageNotIncludes("answer-overflow");

        beginSpeakerTurn(entry);
        const fresh = lastRealtimeBridge();
        agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "fresh answer" }] });
        await emitFinalRealtimeUserTranscript(fresh.bridgeParams, "fresh question");
        expect(fresh.session.sendUserMessage).toHaveBeenCalledWith(
          expect.stringContaining("fresh answer"),
        );
      } finally {
        await manager.destroy();
      }
    });

    it("does not interrupt active exact speech for a later forced agent-proxy consult", async () => {
      agentCommandMock
        .mockResolvedValueOnce({ payloads: [{ text: "first answer" }] })
        .mockResolvedValueOnce({ payloads: [{ text: "second answer" }] });
      const { bridgeParams, entry, player } = await createJoinedAgentProxyFixture();

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "first question");
      await vi.waitFor(() => expectUserMessageIncludes("first answer"));
      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "second question");
      expect(
        realtimeSessionMock.handleBargeIn.mock.calls.some(([arg]) => {
          return (arg as { force?: boolean } | undefined)?.force === true;
        }),
      ).toBe(false);
      expect(player.stop).not.toHaveBeenCalled();
      expectUserMessageNotIncludes("second answer");

      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
      const firstStream = lastAudioResourceInput() as PassThrough | undefined;
      await vi.waitFor(() => expect(firstStream?.writableEnded).toBe(true));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expectUserMessageNotIncludes("second answer");

      const idleHandler = player.on.mock.calls.find(([event]) => event === "idle")?.[1] as
        | (() => void)
        | undefined;
      idleHandler?.();
      expectUserMessageIncludes("second answer");
    });

    it("drains queued exact speech after cancelled prebuffered output is discarded", async () => {
      agentCommandMock
        .mockResolvedValueOnce({ payloads: [{ text: "first answer" }] })
        .mockResolvedValueOnce({ payloads: [{ text: "second answer" }] });
      const { bridgeParams, entry, player } = await createJoinedAgentProxyFixture();

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "first question");
      await vi.waitFor(() => expectUserMessageIncludes("first answer"));
      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "second question");
      expectUserMessageNotIncludes("second answer");

      bridgeParams?.onEvent?.({ direction: "server", type: "response.cancelled" });

      expect(createAudioResourceMock).not.toHaveBeenCalled();
      expect(player.play).not.toHaveBeenCalled();
      expect(player.stop).not.toHaveBeenCalled();
      expectUserMessageIncludes("second answer");
    });

    it("matches agent-proxy consult tool calls to the pending transcript", async () => {
      agentCommandMock
        .mockResolvedValueOnce({ payloads: [{ text: "owner answer" }] })
        .mockResolvedValueOnce({ payloads: [{ text: "guest fallback answer" }] });
      const { entry } = await createJoinedAgentProxyFixture();

      beginSpeakerTurn(entry, { senderIsOwner: false });
      const guest = lastRealtimeBridge();
      beginSpeakerTurn(entry);
      const owner = lastRealtimeBridge();
      await flushRealtimeForcedConsultTimers(async () => {
        guest.bridgeParams.onTranscript?.("user", "guest question", true);
        owner.bridgeParams.onTranscript?.("user", "owner question", true);
        void owner.bridgeParams.onToolCall?.(
          {
            itemId: "item-owner",
            callId: "call-owner",
            name: "openclaw_agent_consult",
            args: { question: "owner question" },
          },
          owner.session,
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      const ownerCommandArgs = agentCommandArgsAt(0);
      expect(ownerCommandArgs.message).toContain("owner question");
      expect(ownerCommandArgs.senderIsOwner).toBe(true);
      const guestCommandArgs = agentCommandArgsAt(1);
      expect(guestCommandArgs.message).toContain("guest question");
      expect(guestCommandArgs.senderIsOwner).toBe(false);
      expect(owner.session.submitToolResult).toHaveBeenCalledWith("call-owner", {
        text: "owner answer",
      });
      expectUserMessageIncludes("guest fallback answer");
    });

    it("reuses forced agent-proxy answers for late matching consult tool calls", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "forced answer" }] });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture();

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "late question");

      void bridgeParams?.onToolCall?.(
        {
          itemId: "item-late",
          callId: "call-late",
          name: "openclaw_agent_consult",
          args: { question: "late question" },
        },
        realtimeSessionMock,
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      expectUserMessageIncludes("forced answer");
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith(
        "call-late",
        {
          status: "already_delivered",
          message: "OpenClaw already delivered this answer to Discord voice. Do not repeat it.",
        },
        { suppressResponse: true },
      );

      realtimeSessionMock.bridge.supportsToolResultSuppression = false;
      void bridgeParams?.onToolCall?.(
        {
          itemId: "item-late-unsuppressed",
          callId: "call-late-unsuppressed",
          name: "openclaw_agent_consult",
          args: { question: "late question" },
        },
        realtimeSessionMock,
      );
      await vi.waitFor(() => {
        const call = realtimeSessionMock.submitToolResult.mock.calls.find(
          ([callId]) => callId === "call-late-unsuppressed",
        );
        expect(call).toEqual([
          "call-late-unsuppressed",
          {
            status: "already_delivered",
            message: "OpenClaw already delivered this answer to Discord voice. Do not repeat it.",
          },
        ]);
      });
    });

    it("lets an unsuppressed in-flight native result own forced consult delivery", async () => {
      let resolveAgentTurn: ((result: { payloads: Array<{ text: string }> }) => void) | undefined;
      agentCommandMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveAgentTurn = resolve;
        }),
      );
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture();
      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "late question");
      realtimeSessionMock.bridge.supportsToolResultSuppression = false;

      const submission = bridgeParams?.onToolCall?.(
        {
          itemId: "item-late",
          callId: "call-late",
          name: "openclaw_agent_consult",
          args: { question: "late question" },
        },
        realtimeSessionMock,
      );
      resolveAgentTurn?.({ payloads: [{ text: "forced answer" }] });
      await submission;

      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-late", {
        text: "forced answer",
      });
      expectUserMessageNotIncludes("forced answer");
      expectUserMessageNotIncludes("I hit an error while checking that. Please try again.");

      let resolveRetryTurn: ((result: { payloads: Array<{ text: string }> }) => void) | undefined;
      agentCommandMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRetryTurn = resolve;
        }),
      );
      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "retry question");
      realtimeSessionMock.submitToolResult.mockRejectedValueOnce(
        new Error("native delivery rejected"),
      );
      const rejectedSubmission = bridgeParams?.onToolCall?.(
        {
          itemId: "item-retry",
          callId: "call-retry",
          name: "openclaw_agent_consult",
          args: { question: "retry question" },
        },
        realtimeSessionMock,
      );
      resolveRetryTurn?.({ payloads: [{ text: "local retry answer" }] });

      await expect(rejectedSubmission).rejects.toThrow("native delivery rejected");
      await vi.waitFor(() => expectUserMessageIncludes("local retry answer"));
    });

    it.each(
      ["Error", "TimeoutError"].flatMap((name) =>
        ["native", "forced-suppressed", "forced-unsuppressed"].map((delivery) => ({
          name,
          delivery,
        })),
      ),
    )(
      "preserves $name failure reporting through $delivery consult delivery",
      async ({ name, delivery }) => {
        const hostTurn = createDeferred<{ payloads: Array<{ text: string }> }>();
        agentCommandMock.mockReturnValueOnce(hostTurn.promise);
        const { bridgeParams, entry, manager } = await createJoinedAgentProxyFixture();
        let submission: Promise<void> | void = undefined;
        try {
          beginSpeakerTurn(entry);
          if (delivery !== "native") {
            await emitFinalRealtimeUserTranscript(bridgeParams, "late question");
          }
          realtimeSessionMock.bridge.supportsToolResultSuppression =
            delivery !== "forced-unsuppressed";
          submission = bridgeParams.onToolCall?.(
            {
              itemId: "item-late",
              callId: "call-late",
              name: "openclaw_agent_consult",
              args: { question: "late question" },
            },
            realtimeSessionMock,
          );
          await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));
          hostTurn.reject(Object.assign(new Error("agent broke"), { name }));
          await submission;
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });

          expect(agentCommandMock).toHaveBeenCalledTimes(1);
          expect(loggerWarnMock).toHaveBeenCalledWith(expect.stringContaining("consult failed"));
          expect(realtimeSessionMock.submitToolResult.mock.calls).toEqual([
            delivery === "forced-suppressed"
              ? [
                  "call-late",
                  {
                    status: "already_delivered",
                    message:
                      "OpenClaw already delivered this answer to Discord voice. Do not repeat it.",
                  },
                  { suppressResponse: true },
                ]
              : ["call-late", { error: "agent broke" }],
          ]);
          if (delivery === "forced-suppressed") {
            expectUserMessageIncludes("I hit an error while checking that. Please try again.");
            expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledOnce();
          } else {
            expect(realtimeSessionMock.sendUserMessage).not.toHaveBeenCalled();
          }
        } finally {
          entry.stop();
          hostTurn.resolve({ payloads: [] });
          await submission;
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          await manager.destroy();
        }
      },
    );

    it("keeps a late agent-proxy result on its speaker after another speaker sends audio", async () => {
      agentCommandMock
        .mockResolvedValueOnce({ payloads: [{ text: "forced answer" }] })
        .mockResolvedValueOnce({ payloads: [{ text: "guest answer" }] });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture();

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "late question");

      beginSpeakerTurn(entry, { senderIsOwner: false });
      const guest = lastRealtimeBridge();

      void bridgeParams?.onToolCall?.(
        {
          itemId: "item-late",
          callId: "call-late",
          name: "openclaw_agent_consult",
          args: { question: "late question" },
        },
        realtimeSessionMock,
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      expectUserMessageIncludes("forced answer");
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith(
        "call-late",
        {
          status: "already_delivered",
          message: "OpenClaw already delivered this answer to Discord voice. Do not repeat it.",
        },
        { suppressResponse: true },
      );
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });

      await emitFinalRealtimeUserTranscript(guest.bridgeParams, "guest followup");

      expect(agentCommandMock).toHaveBeenCalledTimes(2);
      const followupCommandArgs = agentCommandArgsAt(1);
      expect(followupCommandArgs.message).toContain("guest followup");
      expect(followupCommandArgs.senderIsOwner).toBe(false);
      expectUserMessageIncludes("guest answer");
    });

    it("prefers the newest recent agent-proxy consult for repeated questions", async () => {
      agentCommandMock
        .mockResolvedValueOnce({ payloads: [{ text: "old direct answer" }] })
        .mockResolvedValueOnce({ payloads: [{ text: "new forced answer" }] });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture();

      beginSpeakerTurn(entry);
      void bridgeParams?.onToolCall?.(
        {
          itemId: "item-old",
          callId: "call-old",
          name: "openclaw_agent_consult",
          args: { question: "repeat question" },
        },
        realtimeSessionMock,
      );
      await vi.waitFor(() =>
        expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-old", {
          text: "old direct answer",
        }),
      );

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "repeat question");

      void bridgeParams?.onToolCall?.(
        {
          itemId: "item-new",
          callId: "call-new",
          name: "openclaw_agent_consult",
          args: { question: "repeat question" },
        },
        realtimeSessionMock,
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(agentCommandMock).toHaveBeenCalledTimes(2);
      expectUserMessageIncludes("new forced answer");
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith(
        "call-new",
        {
          status: "already_delivered",
          message: "OpenClaw already delivered this answer to Discord voice. Do not repeat it.",
        },
        { suppressResponse: true },
      );
      expect(realtimeSessionMock.submitToolResult).not.toHaveBeenCalledWith("call-new", {
        text: "old direct answer",
      });
    });

    it("attributes a later agent-proxy speaker after the previous capture closes", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "guest answer" }] });
      const { entry } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { debounceMs: 1 } } },
      });
      const ownerTurn = beginSpeakerTurn(entry);
      ownerTurn.close();
      beginSpeakerTurn(entry, { senderIsOwner: false });
      const guest = lastRealtimeBridge();

      await emitFinalRealtimeUserTranscript(guest.bridgeParams, "guest question");

      expectUserMessageIncludes("guest answer");
      expect(lastAgentCommandArgs().senderIsOwner).toBe(false);
    });

    it("starts Discord realtime voice in bidi mode with the consult tool", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "consult answer" }] });
      const { bridgeParams, entry } = await createJoinedBidiFixture({
        voice: {
          model: "openai/gpt-5.5",
          realtime: {
            model: "gpt-realtime-2",
            speakerVoice: "cedar",
            toolPolicy: "safe-read-only",
            consultPolicy: "always",
            requireWakeName: true,
            providers: {
              openai: {
                interruptResponseOnInputAudio: false,
              },
            },
          },
        },
      });
      beginSpeakerTurn(entry);

      expect(bridgeParams?.autoRespondToAudio).toBe(true);
      expect(bridgeParams?.interruptResponseOnInputAudio).toBe(false);
      expect(bridgeParams?.instructions).toContain("Call openclaw_agent_consult");
      expect(bridgeParams?.tools?.map((tool) => tool.name)).toContain("openclaw_agent_consult");

      void bridgeParams?.onToolCall?.(
        {
          itemId: "item-1",
          callId: "call-1",
          name: "openclaw_agent_consult",
          args: { question: "check my Discord" },
        },
        realtimeSessionMock,
      );
      await vi.waitFor(() =>
        expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-1", {
          text: "consult answer",
        }),
      );

      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledTimes(1);
      const commandArgs = lastAgentCommandArgs();
      expect(commandArgs.toolsAllow).toEqual([
        "read",
        "web_search",
        "web_fetch",
        "x_search",
        "memory_search",
        "memory_get",
      ]);
    });

    it("adds default bootstrap profile context to realtime voice instructions", async () => {
      resolveAgentRouteMock.mockReturnValue({
        agentId: "main",
        sessionKey: "agent:main:discord:channel:1001",
      });
      resolveRealtimeBootstrapContextInstructionsMock.mockResolvedValue(
        "OpenClaw realtime voice profile context:\n\n### IDENTITY.md\nName: Wilfred",
      );
      const { bridgeParams } = await createJoinedBidiFixture({
        voice: { realtime: { consultPolicy: "always" } },
      });

      expect(resolveRealtimeBootstrapContextInstructionsMock).toHaveBeenCalledWith({
        config: {},
        agentId: "main",
        sessionKey: "agent:main:discord:channel:1001",
        files: undefined,
        warn: expect.any(Function),
      });
      expect(bridgeParams?.instructions).toContain("OpenClaw realtime voice profile context");
      expect(bridgeParams?.instructions).toContain("Name: Wilfred");
      expect(bridgeParams?.instructions).toContain("short natural backchannel");
      expect(bridgeParams?.instructions).toContain("Call openclaw_agent_consult");
    });

    it("routes bidi realtime consults through a configured voice agent session target", async () => {
      resolveAgentRouteMock.mockImplementation((params?: { peer?: { id?: string } }) => {
        if (params?.peer?.id === "maintainers") {
          return {
            agentId: "main",
            sessionKey: "agent:main:discord:channel:maintainers",
          };
        }
        return {
          agentId: "main",
          sessionKey: "agent:main:discord:channel:1001",
        };
      });
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "maintainer answer" }] });
      const { bridgeParams, entry } = await createJoinedBidiFixture({
        voice: {
          agentSession: {
            mode: "target",
            target: "channel:maintainers",
          },
          realtime: { consultPolicy: "always" },
        },
      });
      expect(entry.voiceSessionKey).toBe("agent:main:discord:channel:1001");
      expect(entry.route?.sessionKey).toBe("agent:main:discord:channel:maintainers");

      beginSpeakerTurn(entry);

      void bridgeParams?.onToolCall?.(
        {
          itemId: "item-1",
          callId: "call-1",
          name: "openclaw_agent_consult",
          args: { question: "check the maintainer channel context" },
        },
        realtimeSessionMock,
      );
      await vi.waitFor(() =>
        expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-1", {
          text: "maintainer answer",
        }),
      );

      expect(lastAgentCommandArgs().sessionKey).toBe("agent:main:discord:channel:maintainers");
    });

    it("keeps bidi realtime consults on the audio turn speaker context", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "guest consult answer" }] });
      const { bridgeParams, entry } = await createJoinedBidiFixture({
        voice: {
          realtime: {
            toolPolicy: "safe-read-only",
            consultPolicy: "always",
          },
        },
      });
      beginSpeakerTurn(entry, { senderIsOwner: false });
      beginSpeakerTurn(entry);

      void bridgeParams?.onToolCall?.(
        {
          itemId: "item-guest",
          callId: "call-guest",
          name: "openclaw_agent_consult",
          args: { question: "guest question" },
        },
        realtimeSessionMock,
      );
      await Promise.resolve();
      await Promise.resolve();

      const commandArgs = lastAgentCommandArgs();
      expect(commandArgs.senderIsOwner).toBe(false);
      expect(commandArgs.toolsAllow).toEqual([
        "read",
        "web_search",
        "web_fetch",
        "x_search",
        "memory_search",
        "memory_get",
      ]);
    });

    it("attributes a later bidi consult after the previous speaker capture closes", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "guest consult answer" }] });
      const { entry } = await createJoinedBidiFixture({
        voice: {
          realtime: {
            toolPolicy: "safe-read-only",
            consultPolicy: "always",
          },
        },
      });
      const ownerTurn = beginSpeakerTurn(entry);
      ownerTurn.close();
      beginSpeakerTurn(entry, { senderIsOwner: false });
      const guest = lastRealtimeBridge();

      void guest.bridgeParams.onToolCall?.(
        {
          itemId: "item-guest",
          callId: "call-guest",
          name: "openclaw_agent_consult",
          args: { question: "guest question" },
        },
        guest.session,
      );
      await Promise.resolve();
      await Promise.resolve();

      const commandArgs = lastAgentCommandArgs();
      expect(commandArgs.senderIsOwner).toBe(false);
      expect(commandArgs.toolsAllow).toEqual([
        "read",
        "web_search",
        "web_fetch",
        "x_search",
        "memory_search",
        "memory_get",
      ]);
    });
  },
);
