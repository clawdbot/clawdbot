import type { PassThrough } from "node:stream";
import type { RealtimeVoiceSessionHarness } from "openclaw/plugin-sdk/realtime-voice";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    ChannelType,
    createAudioResourceMock,
    resolveAgentRouteMock,
    agentCommandMock,
    resolveRealtimeBootstrapContextInstructionsMock,
    realtimeSessionMock,
    createClient,
    getSessionEntry,
    beginSpeakerTurn,
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

    it("terminates realtime voice when retained Unicode speech exceeds the byte budget", async () => {
      const client = createClient();
      client.fetchChannel.mockImplementation(async (channelId: string) => {
        const guildId = channelId === "2001" ? "g2" : "g1";
        return {
          id: channelId,
          guildId,
          guild: { id: guildId, name: guildId },
          type: ChannelType.GuildVoice,
        };
      });
      const { bridgeParams, entry, manager } = await createJoinedAgentProxyFixture({ client });
      const realtime = entry.realtime as unknown as {
        playback: { enqueueExactSpeechMessage: (text: string) => void };
      };
      const connection = (entry as unknown as { connection: { destroy: ReturnType<typeof vi.fn> } })
        .connection;
      const accepted = "😀".repeat(8 * 1024);
      expect(accepted.length).toBe(16 * 1024);
      expect(Buffer.byteLength(accepted, "utf8")).toBe(32 * 1024);

      await manager.join({ guildId: "g2", channelId: "2001" });
      const siblingRealtime = getSessionEntry(manager, "g2").realtime as unknown as {
        playback: { enqueueExactSpeechMessage: (text: string) => void };
      };

      realtime.playback.enqueueExactSpeechMessage(accepted);
      expectUserMessageIncludes(accepted);
      expect(manager.status()).toHaveLength(2);

      realtime.playback.enqueueExactSpeechMessage("overflow");

      expect(manager.status()).toEqual([
        expect.objectContaining({ guildId: "g2", channelId: "2001" }),
      ]);
      expect(connection.destroy).toHaveBeenCalledOnce();
      expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
      expectUserMessageNotIncludes("overflow");

      siblingRealtime.playback.enqueueExactSpeechMessage("sibling remains usable");
      expectUserMessageIncludes("sibling remains usable");

      bridgeParams.onReady?.();
      bridgeParams.onEvent?.({ direction: "server", type: "response.done" });
      realtime.playback.enqueueExactSpeechMessage("late");
      entry.stop();

      expect(connection.destroy).toHaveBeenCalledOnce();
      expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
      expectUserMessageNotIncludes("late");
    });

    it("terminates realtime voice when retained exact speech exceeds the message budget", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture();
      const realtime = entry.realtime as unknown as {
        playback: { enqueueExactSpeechMessage: (text: string) => void };
      };
      const connection = (entry as unknown as { connection: { destroy: ReturnType<typeof vi.fn> } })
        .connection;

      for (let index = 0; index < 32; index += 1) {
        realtime.playback.enqueueExactSpeechMessage(`answer-${index}`);
      }

      expect(manager.status()).toHaveLength(1);
      expect(realtimeSessionMock.sendUserMessage).toHaveBeenCalledOnce();

      realtime.playback.enqueueExactSpeechMessage("answer-overflow");

      expect(manager.status()).toStrictEqual([]);
      expect(connection.destroy).toHaveBeenCalledOnce();
      expect(realtimeSessionMock.close).toHaveBeenCalledOnce();
      expectUserMessageNotIncludes("answer-overflow");
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
      expect(player.stop).toHaveBeenCalledWith(true);
      expectUserMessageIncludes("second answer");
    });

    it("matches agent-proxy consult tool calls to the pending transcript", async () => {
      agentCommandMock
        .mockResolvedValueOnce({ payloads: [{ text: "owner answer" }] })
        .mockResolvedValueOnce({ payloads: [{ text: "guest fallback answer" }] });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture();

      beginSpeakerTurn(entry, { senderIsOwner: false });

      beginSpeakerTurn(entry);
      await flushRealtimeForcedConsultTimers(async () => {
        bridgeParams?.onTranscript?.("user", "guest question", true);
        bridgeParams?.onTranscript?.("user", "owner question", true);
        void bridgeParams?.onToolCall?.(
          {
            itemId: "item-owner",
            callId: "call-owner",
            name: "openclaw_agent_consult",
            args: { question: "owner question" },
          },
          realtimeSessionMock,
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      const ownerCommandArgs = agentCommandArgsAt(0);
      expect(ownerCommandArgs.message).toContain("owner question");
      const guestCommandArgs = agentCommandArgsAt(1);
      expect(guestCommandArgs.message).toContain("guest question");
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-owner", {
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

    it("terminally satisfies a late native call for a cancelled forced consult", async () => {
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture();
      const realtime = entry.realtime as unknown as {
        harness: RealtimeVoiceSessionHarness;
      };
      const cancelled = realtime.harness.forcedConsults.prepare("cancelled question");
      if (!cancelled) {
        throw new Error("expected forced consult handle");
      }
      realtime.harness.forcedConsults.markStarted(cancelled);
      realtime.harness.forcedConsults.markCancelled(cancelled);

      await bridgeParams?.onToolCall?.(
        {
          itemId: "item-cancelled",
          callId: "call-cancelled",
          name: "openclaw_agent_consult",
          args: { question: "cancelled question" },
        },
        realtimeSessionMock,
      );

      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith(
        "call-cancelled",
        {
          status: "cancelled",
          message: "OpenClaw cancelled this consult before completion. Do not restart it.",
        },
        { suppressResponse: true },
      );
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

    it("suppresses late forced agent-proxy tool calls when the forced consult rejects", async () => {
      let rejectAgentTurn: ((error: unknown) => void) | undefined;
      agentCommandMock.mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectAgentTurn = reject;
        }),
      );
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
      rejectAgentTurn?.(new Error("agent broke"));
      await vi.waitFor(() =>
        expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith(
          "call-late",
          {
            status: "already_delivered",
            message: "OpenClaw already delivered this answer to Discord voice. Do not repeat it.",
          },
          { suppressResponse: true },
        ),
      );

      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      expectUserMessageIncludes("I hit an error while checking that. Please try again.");
    });

    it("does not reuse recent agent-proxy answers over newer speaker audio", async () => {
      agentCommandMock
        .mockResolvedValueOnce({ payloads: [{ text: "forced answer" }] })
        .mockResolvedValueOnce({ payloads: [{ text: "guest answer" }] });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture();

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "late question");

      beginSpeakerTurn(entry, { senderIsOwner: false });

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
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-late", {
        error: "Discord speaker context changed before this realtime consult completed",
      });
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });

      await emitFinalRealtimeUserTranscript(bridgeParams, "guest followup");

      expect(agentCommandMock).toHaveBeenCalledTimes(2);
      const followupCommandArgs = agentCommandArgsAt(1);
      expect(followupCommandArgs.message).toContain("guest followup");
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

    it("expires closed agent-proxy turns before later speaker audio", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "guest answer" }] });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { debounceMs: 1 } } },
      });
      const ownerTurn = beginSpeakerTurn(entry);
      ownerTurn?.close();
      beginSpeakerTurn(entry, { senderIsOwner: false });

      await emitFinalRealtimeUserTranscript(bridgeParams, "guest question");

      expectUserMessageIncludes("guest answer");
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
      const ownerTurn = entry?.realtime?.beginSpeakerTurn(
        { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
        "u-owner",
      );
      ownerTurn?.sendInputAudio(Buffer.alloc(8));

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
      const nonOwnerTurn = entry?.realtime?.beginSpeakerTurn(
        { extraSystemPrompt: undefined, senderIsOwner: false, speakerLabel: "Guest" },
        "u-guest",
      );
      nonOwnerTurn?.sendInputAudio(Buffer.alloc(8));
      const ownerTurn = entry?.realtime?.beginSpeakerTurn(
        { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
        "u-owner",
      );
      ownerTurn?.sendInputAudio(Buffer.alloc(8));

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
      expect(commandArgs.toolsAllow).toEqual([
        "read",
        "web_search",
        "web_fetch",
        "x_search",
        "memory_search",
        "memory_get",
      ]);
    });

    it("expires closed bidi turns before later speaker consults", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "guest consult answer" }] });
      const { bridgeParams, entry } = await createJoinedBidiFixture({
        voice: {
          realtime: {
            toolPolicy: "safe-read-only",
            consultPolicy: "always",
          },
        },
      });
      const ownerTurn = beginSpeakerTurn(entry);
      ownerTurn?.close();
      beginSpeakerTurn(entry, { senderIsOwner: false });

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
