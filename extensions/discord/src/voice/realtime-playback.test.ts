import type { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import type { RealtimeVoiceSessionHarness } from "openclaw/plugin-sdk/realtime-voice";
import type { MockCallSource } from "./manager.e2e.test-support.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    requireRecord,
    lastMockCall,
    createAudioResourceMock,
    agentCommandMock,
    resolveConfiguredRealtimeVoiceProviderMock,
    controlRealtimeVoiceAgentRunMock,
    realtimeSessionMock,
    createManager,
    createAgentProxyManager,
    getSessionEntry,
    beginSpeakerTurn,
    getLastAudioPlayer,
    lastAgentCommandArgs,
    lastRealtimeBridgeParams,
    createJoinedAgentProxyFixture,
    lastAudioResourceInput,
    expectUserMessageIncludes,
    expectUserMessageNotIncludes,
  }) => {
    it("uses agent-proxy realtime voice by default", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "agent proxy answer" }] });
      const cfg = { auth: { order: { openai: ["openai:codex-cli"] } } } as never;
      const manager = createManager(
        {
          groupPolicy: "open",
          voice: {
            enabled: true,
            model: "openai/gpt-5.5",
            realtime: {
              provider: "openai",
              model: "gpt-realtime-2",
              speakerVoice: "cedar",
              debounceMs: 1,
            },
          },
        },
        undefined,
        cfg,
      );

      const result = await manager.join({ guildId: "g1", channelId: "1001" });

      expect(result.ok).toBe(true);
      const entry = getSessionEntry(manager);
      const ownerTurn = entry?.realtime?.beginSpeakerTurn(
        { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
        "u-owner",
      );
      ownerTurn?.sendInputAudio(Buffer.alloc(8));
      const providerOptions = requireRecord(
        lastMockCall(
          resolveConfiguredRealtimeVoiceProviderMock as unknown as MockCallSource,
          "provider resolve",
        )[0],
        "provider resolve options",
      );
      expect(providerOptions.configuredProviderId).toBe("openai");
      expect(providerOptions.defaultModel).toBe("gpt-realtime-2");
      expect(providerOptions.providerConfigOverrides).toEqual({
        model: "gpt-realtime-2",
        voice: "cedar",
      });
      const bridgeParams = lastRealtimeBridgeParams();
      expect(bridgeParams?.cfg).toBe(cfg);
      expect(bridgeParams?.autoRespondToAudio).toBe(false);
      expect(bridgeParams?.instructions).toContain("same OpenClaw agent");
      expect(bridgeParams?.instructions).toContain("short natural backchannel");
      expect(bridgeParams?.tools?.map((tool) => tool.name)).toContain("openclaw_agent_consult");
      expect(bridgeParams?.tools?.map((tool) => tool.name)).toContain("openclaw_agent_control");
      const player = getLastAudioPlayer();
      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(24_000));
      expect(player.play).toHaveBeenCalled();
      const stopCallsBeforeConsult = player.stop.mock.calls.length;

      void bridgeParams?.onToolCall?.(
        {
          itemId: "item-1",
          callId: "call-1",
          name: "openclaw_agent_consult",
          args: { question: "what did I ask?" },
        },
        realtimeSessionMock,
      );
      expect(player.stop).toHaveBeenCalledTimes(stopCallsBeforeConsult);
      await vi.waitFor(() =>
        expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-1", {
          text: "agent proxy answer",
        }),
      );

      const commandArgs = lastAgentCommandArgs();
      expect(commandArgs.model).toBe("openai/gpt-5.5");
      expect(commandArgs.messageProvider).toBe("discord-voice");
      expect(commandArgs.toolsAllow).toBeUndefined();
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledTimes(1);
    });

    it("handles semantic realtime agent-control tool calls in Discord VC", async () => {
      controlRealtimeVoiceAgentRunMock.mockResolvedValueOnce({
        ok: true,
        mode: "steer",
        sessionKey: "discord:g1:c1",
        sessionId: "embedded-active",
        active: true,
        queued: true,
        target: "embedded_run",
        message: "Got it. I steered the active run.",
        speak: true,
        show: true,
        suppress: false,
      });
      const { bridgeParams } = await createJoinedAgentProxyFixture();

      void bridgeParams?.onToolCall?.(
        {
          itemId: "item-control",
          callId: "call-control",
          name: "openclaw_agent_control",
          args: { text: "revísalo en WebUI", mode: "steer" },
        },
        realtimeSessionMock,
      );

      await vi.waitFor(() =>
        expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledWith({
          sessionKey: "discord:g1:c1",
          text: "revísalo en WebUI",
          mode: "steer",
        }),
      );
      await vi.waitFor(() =>
        expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith(
          "call-control",
          expect.objectContaining({ mode: "steer", queued: true }),
        ),
      );
    });

    it("keeps the realtime tool callback pending until result delivery completes", async () => {
      let acceptResult = () => {};
      const accepted = new Promise<void>((resolve) => {
        acceptResult = resolve;
      });
      realtimeSessionMock.submitToolResult.mockImplementationOnce(() => accepted);
      const { bridgeParams } = await createJoinedAgentProxyFixture();

      const handled = bridgeParams?.onToolCall?.(
        {
          itemId: "item-unknown",
          callId: "call-unknown",
          name: "unknown_tool",
          args: {},
        },
        realtimeSessionMock,
      );
      if (!handled) {
        throw new Error("expected realtime tool callback promise");
      }
      let settled = false;
      void handled.then(() => {
        settled = true;
      });
      await Promise.resolve();

      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      acceptResult();
      await handled;
      expect(settled).toBe(true);
    });

    it("does not retry a rejected control result submission as a tool error", async () => {
      realtimeSessionMock.submitToolResult.mockRejectedValueOnce(
        new Error("result delivery failed"),
      );
      const { bridgeParams } = await createJoinedAgentProxyFixture();

      const handled = bridgeParams?.onToolCall?.(
        {
          itemId: "item-control",
          callId: "call-control",
          name: "openclaw_agent_control",
          args: { text: "check this", mode: "steer" },
        },
        realtimeSessionMock,
      );
      if (!handled) {
        throw new Error("expected realtime tool callback promise");
      }

      await expect(handled).rejects.toThrow("result delivery failed");
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledTimes(1);
    });

    it("rejects malformed realtime consult tool calls without crashing Discord voice", async () => {
      const { bridgeParams } = await createJoinedAgentProxyFixture();

      expect(() =>
        bridgeParams?.onToolCall?.(
          {
            itemId: "item-empty-consult",
            callId: "call-empty-consult",
            name: "openclaw_agent_consult",
            args: {},
          },
          realtimeSessionMock,
        ),
      ).not.toThrow();

      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-empty-consult", {
        error: "question required",
      });
    });

    it("does not require speaker context for internal exact-speech consults", async () => {
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture();
      const realtime = entry.realtime as unknown as {
        playback: { enqueueExactSpeechMessage: (text: string) => void };
      };
      realtime.playback.enqueueExactSpeechMessage("already answered");
      realtime.playback.enqueueExactSpeechMessage("direct internal answer");

      void bridgeParams?.onToolCall?.(
        {
          itemId: "item-exact",
          callId: "call-exact",
          name: "openclaw_agent_consult",
          args: {
            question: "Should I repeat the previous voice result?",
            context: 'The retained answer was "already answered".',
          },
        },
        realtimeSessionMock,
      );
      void bridgeParams?.onToolCall?.(
        {
          itemId: "item-internal",
          callId: "call-internal",
          name: "openclaw_agent_consult",
          args: {
            question: [
              "Speak this exact OpenClaw answer to the Discord voice channel, without adding, removing, or rephrasing words.",
              'Answer: "direct internal answer"',
            ].join("\n"),
          },
        },
        realtimeSessionMock,
      );

      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledTimes(2);
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-exact", {
        text: "already answered",
      });
      expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-internal", {
        text: "direct internal answer",
      });
    });

    it("creates a fresh realtime output stream after the Discord player idles", async () => {
      const manager = createAgentProxyManager();

      const result = await manager.join({ guildId: "g1", channelId: "1001" });

      expect(result.ok).toBe(true);
      const player = getLastAudioPlayer() as {
        on: ReturnType<typeof vi.fn>;
        play: ReturnType<typeof vi.fn>;
      };
      const bridgeParams = lastRealtimeBridgeParams();

      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
      expect(createAudioResourceMock).not.toHaveBeenCalled();
      expect(player.play).not.toHaveBeenCalled();
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
      expect(createAudioResourceMock).toHaveBeenCalledTimes(1);
      expect(player.play).toHaveBeenCalledTimes(1);
      const firstStream = lastAudioResourceInput() as { writableEnded?: boolean } | undefined;
      await vi.waitFor(() => expect(firstStream?.writableEnded).toBe(true));

      const idleHandler = player.on.mock.calls.find(([event]) => event === "idle")?.[1] as
        | (() => void)
        | undefined;
      expect(idleHandler).toBeTypeOf("function");
      idleHandler?.();

      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
      expect(createAudioResourceMock).toHaveBeenCalledTimes(1);
      expect(player.play).toHaveBeenCalledTimes(1);
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
      expect(createAudioResourceMock).toHaveBeenCalledTimes(2);
      expect(player.play).toHaveBeenCalledTimes(2);
    });

    it("clears stale realtime playback when stream close and player idle do not fire", async () => {
      vi.useFakeTimers();
      try {
        const manager = createAgentProxyManager();

        const result = await manager.join({ guildId: "g1", channelId: "1001" });

        expect(result.ok).toBe(true);
        const player = getLastAudioPlayer();
        const bridgeParams = lastRealtimeBridgeParams();

        bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
        bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
        const stream = lastAudioResourceInput() as PassThrough | undefined;
        stream?.removeAllListeners("close");

        await vi.advanceTimersByTimeAsync(3_009);
        expect(player.stop).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(player.stop).toHaveBeenCalledWith(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not let an old realtime playback watchdog stop a later response", async () => {
      vi.useFakeTimers();
      try {
        const manager = createAgentProxyManager();

        await manager.join({ guildId: "g1", channelId: "1001" });

        const player = getLastAudioPlayer();
        const bridgeParams = lastRealtimeBridgeParams();

        bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
        bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
        const firstStream = lastAudioResourceInput() as PassThrough;
        firstStream.resume();
        await finished(firstStream);
        const idleHandler = player.on.mock.calls.find(([event]) => event === "idle")?.[1];
        idleHandler?.();

        bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
        await vi.advanceTimersByTimeAsync(3_010);

        expect(player.stop).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps queued exact speech pending after encoder close until the player idles", async () => {
      vi.useFakeTimers();
      try {
        agentCommandMock
          .mockResolvedValueOnce({ payloads: [{ text: "first answer" }] })
          .mockResolvedValueOnce({ payloads: [{ text: "second answer" }] })
          .mockResolvedValueOnce({ payloads: [{ text: "third answer" }] });
        const manager = createAgentProxyManager();

        await manager.join({ guildId: "g1", channelId: "1001" });
        const player = getLastAudioPlayer();
        const entry = getSessionEntry(manager);
        const bridgeParams = lastRealtimeBridgeParams();

        beginSpeakerTurn(entry);
        bridgeParams?.onTranscript?.("user", "first question", true);
        await vi.advanceTimersByTimeAsync(260);
        await vi.waitFor(() => expectUserMessageIncludes("first answer"));
        bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

        beginSpeakerTurn(entry);
        bridgeParams?.onTranscript?.("user", "second question", true);
        await vi.advanceTimersByTimeAsync(260);
        expectUserMessageNotIncludes("second answer");

        bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
        const firstStream = lastAudioResourceInput() as PassThrough;
        firstStream.resume();
        await finished(firstStream);

        await vi.advanceTimersByTimeAsync(1_510);
        expectUserMessageNotIncludes("second answer");

        const idleHandler = player.on.mock.calls.find(([event]) => event === "idle")?.[1] as
          | (() => void)
          | undefined;
        idleHandler?.();
        expectUserMessageIncludes("second answer");
        beginSpeakerTurn(entry);
        bridgeParams?.onTranscript?.("user", "third question", true);
        await vi.advanceTimersByTimeAsync(260);
        expectUserMessageNotIncludes("third answer");
      } finally {
        vi.useRealTimers();
      }
    });

    it("prebuffers realtime output before starting Discord playback", async () => {
      const { bridgeParams, player } = await createJoinedAgentProxyFixture();

      for (let index = 0; index < 49; index += 1) {
        bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
      }

      expect(createAudioResourceMock).not.toHaveBeenCalled();
      expect(player.play).not.toHaveBeenCalled();

      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));

      expect(createAudioResourceMock).toHaveBeenCalledTimes(1);
      expect(player.play).toHaveBeenCalledTimes(1);
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
    });

    it("drains a complete 6.8-second provider burst in order after backpressure and response completion", async () => {
      const { bridgeParams, entry, manager, player } = await createJoinedAgentProxyFixture();
      const realtime = entry.realtime as unknown as {
        playback: { currentOutputStream: () => PassThrough | null };
      };
      // Real provider chunks are 400 ms; Discord's consumer has not drained any yet.
      const expected = Array.from({ length: 17 }, (_, index) => {
        bridgeParams.audioSink.sendAudio(Buffer.alloc(19_200, index));
        return Buffer.alloc(76_800, index);
      });
      const stream = realtime.playback.currentOutputStream();
      const output = lastAudioResourceInput() as PassThrough;
      expect(stream?.writableNeedDrain).toBe(true);
      expect(player.stop).not.toHaveBeenCalled();
      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();

      bridgeParams.onResponseDone?.({ status: "completed" });
      expect(stream?.writableEnded).toBe(false);
      const received: Buffer[] = [];
      output.on("data", (chunk: Buffer) => received.push(chunk));
      await finished(output);

      expect(Buffer.concat(received)).toEqual(Buffer.concat(expected));
      expect(player.play).toHaveBeenCalledOnce();
      expect(player.stop).not.toHaveBeenCalled();
      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
      await manager.leave({ guildId: "g1" });
    });

    it("does not let a cancelled response's drain resume or end a later response", async () => {
      const { bridgeParams, entry, manager, player } = await createJoinedAgentProxyFixture();
      const realtime = entry.realtime as unknown as {
        playback: { currentOutputStream: () => PassThrough | null };
      };
      for (let index = 0; index < 17; index += 1) {
        bridgeParams.audioSink.sendAudio(Buffer.alloc(19_200));
      }
      const oldStream = realtime.playback.currentOutputStream();
      expect(oldStream?.writableNeedDrain).toBe(true);

      bridgeParams.onResponseDone?.({ status: "cancelled" });
      bridgeParams.audioSink.sendAudio(Buffer.alloc(24_000));
      const nextStream = realtime.playback.currentOutputStream();
      expect(nextStream).not.toBe(oldStream);
      oldStream?.emit("drain");
      await Promise.resolve();

      expect(nextStream?.destroyed).toBe(false);
      expect(nextStream?.writableEnded).toBe(false);
      expect(player.stop).toHaveBeenCalledOnce();
      expect(player.play).toHaveBeenCalledTimes(2);
      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
      await manager.leave({ guildId: "g1" });
    });

    it("releases queued speech after an encoder failure without waiting for a missing idle event", async () => {
      const { bridgeParams, entry, manager, player } = await createJoinedAgentProxyFixture();
      const realtime = entry.realtime as unknown as {
        playback: { enqueueExactSpeechMessage: (text: string) => void };
      };
      realtime.playback.enqueueExactSpeechMessage("first answer");
      bridgeParams.audioSink.sendAudio(Buffer.alloc(24_000));
      realtime.playback.enqueueExactSpeechMessage("second answer");
      expectUserMessageNotIncludes("second answer");

      const output = lastAudioResourceInput() as PassThrough;
      output.destroy(new Error("encoder failed"));

      await vi.waitFor(() => expectUserMessageIncludes("second answer"));
      expect(player.stop).toHaveBeenCalledWith(true);
      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
      await manager.leave({ guildId: "g1" });
    });

    it.each([
      [
        { status: "failed" as const, responseId: "response-1", message: "provider failed" },
        "turn.ended",
      ],
      [
        {
          status: "incomplete" as const,
          responseId: "response-1",
          reason: "max_output_tokens",
          message: "provider response incomplete",
        },
        "turn.ended",
      ],
      [
        { status: "cancelled" as const, responseId: "response-1", reason: "client_cancelled" },
        "turn.cancelled",
      ],
    ])("retires each response once and plays a later response", async (outcome, terminalType) => {
      const { bridgeParams, entry, manager, player } = await createJoinedAgentProxyFixture();
      const realtime = entry.realtime as unknown as { harness: RealtimeVoiceSessionHarness };

      bridgeParams.onEvent?.({
        direction: "server",
        type: "response.created",
        responseId: outcome.responseId,
      });
      bridgeParams.audioSink.sendAudio(Buffer.alloc(480));
      bridgeParams.onResponseDone?.(outcome);
      bridgeParams.onEvent?.({
        direction: "server",
        responseId: outcome.responseId,
        type: "response.done",
      });

      expect(
        realtime.harness.talk.recentEvents.filter((event) => event.type === terminalType),
      ).toHaveLength(1);
      expect(manager.status()).toHaveLength(1);
      expect(realtimeSessionMock.close).not.toHaveBeenCalled();
      expect(player.stop).toHaveBeenCalledTimes(1);

      bridgeParams.onEvent?.({
        direction: "server",
        type: "response.created",
        responseId: "response-2",
      });
      bridgeParams.audioSink.sendAudio(Buffer.alloc(480));
      bridgeParams.onResponseDone?.({ status: "completed", responseId: "response-2" });
      bridgeParams.onEvent?.({
        direction: "server",
        responseId: "response-2",
        type: "response.done",
      });

      expect(
        realtime.harness.talk.recentEvents.filter(
          (event) => event.type === "turn.ended" || event.type === "turn.cancelled",
        ),
      ).toHaveLength(2);
      expect(createAudioResourceMock).toHaveBeenCalledOnce();
      expect(player.play).toHaveBeenCalledOnce();
      expect(manager.status()).toHaveLength(1);
    });

    it("discards prebuffered realtime output when the response is cancelled", async () => {
      const { bridgeParams, player } = await createJoinedAgentProxyFixture();

      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
      bridgeParams?.onEvent?.({ direction: "server", type: "response.cancelled" });

      expect(createAudioResourceMock).not.toHaveBeenCalled();
      expect(player.play).not.toHaveBeenCalled();
      expect(player.stop).toHaveBeenCalledWith(true);

      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
      bridgeParams?.onResponseDone?.({
        status: "cancelled",
        reason: "client_cancelled",
      });

      expect(createAudioResourceMock).not.toHaveBeenCalled();
      expect(player.play).not.toHaveBeenCalled();
      expect(player.stop).toHaveBeenCalledTimes(2);
    });
  },
);
