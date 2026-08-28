import type { RealtimeVoiceAgentControlResult } from "openclaw/plugin-sdk/realtime-voice";
import type { MockCallSource } from "./manager.e2e.test-support.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    requireRecord,
    lastMockCall,
    agentCommandMock,
    textToSpeechMock,
    resolveConfiguredRealtimeVoiceProviderMock,
    controlRealtimeVoiceAgentRunMock,
    realtimeSessionMock,
    configureVoiceStateGateway,
    createClient,
    createManager,
    makeVoiceConfig,
    createAgentProxyManager,
    getSessionEntry,
    beginSpeakerTurn,
    createWakeNameFixture,
    lastAgentCommandArgs,
    agentCommandArgsAt,
    lastRealtimeBridgeParams,
    createJoinedAgentProxyFixture,
    sentUserMessages,
    emitFinalRealtimeUserTranscript,
    flushRealtimeForcedConsultTimers,
    expectUserMessageIncludes,
    expectUserMessageNotIncludes,
  }) => {
    it.each(["before-final", "before-delivery"] as const)(
      "keeps realtime transcript output with its retired audio binding %s",
      async (ordering) => {
        const manager = createAgentProxyManager(undefined, {
          voice: { realtime: { requireWakeName: true } },
        });
        await manager.join({ guildId: "g1", channelId: "1001" });
        const first = vi.fn();
        const second = vi.fn();
        await manager.join(
          { guildId: "g1", channelId: "1001" },
          { transcripts: { sessionId: "old", onUtterance: first } },
        );
        const entry = getSessionEntry(manager);
        const bridge = lastRealtimeBridgeParams();
        beginSpeakerTurn(entry);
        if (ordering === "before-delivery") {
          bridge?.onTranscript?.("user", "old room speech", true);
        }
        const replacing = manager.join(
          { guildId: "g1", channelId: "1001" },
          { transcripts: { sessionId: "new", onUtterance: second } },
        );
        await replacing;
        if (ordering === "before-final") {
          bridge?.onTranscript?.("user", "old room speech", true);
        }
        await Promise.resolve();
        expect(first).not.toHaveBeenCalled();
        expect(second).not.toHaveBeenCalled();
        beginSpeakerTurn(entry);
        await emitFinalRealtimeUserTranscript(bridge, "fresh room speech");
        expect(second).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: "new", text: "fresh room speech" }),
        );
        await manager.destroy();
      },
    );

    it("applies Discord realtime model and voice overrides during provider auto-selection", async () => {
      const manager = createManager(
        makeVoiceConfig(
          {
            mode: "agent-proxy",
            realtime: {
              model: "gpt-realtime-2",
              speakerVoiceId: "cedar",
              minBargeInAudioEndMs: 500,
              providers: {
                openai: { model: "provider-default", voice: "marin" },
              },
            },
          },
          { groupPolicy: "open" },
        ),
      );

      const result = await manager.join({ guildId: "g1", channelId: "1001" });

      expect(result.ok).toBe(true);
      const providerOptions = requireRecord(
        lastMockCall(
          resolveConfiguredRealtimeVoiceProviderMock as unknown as MockCallSource,
          "provider resolve",
        )[0],
        "provider resolve options",
      );
      expect(providerOptions.configuredProviderId).toBeUndefined();
      expect(providerOptions.agentId).toBe("agent-1");
      expect(providerOptions.defaultModel).toBe("gpt-realtime-2");
      expect(requireRecord(providerOptions.providerConfigs, "provider configs").openai).toEqual({
        model: "provider-default",
        voice: "marin",
      });
      expect(providerOptions.providerConfigOverrides).toEqual({
        model: "gpt-realtime-2",
        voice: "cedar",
        minBargeInAudioEndMs: 500,
      });
      expect(lastRealtimeBridgeParams().agentId).toBe("agent-1");
    });

    it("keeps agent-proxy realtime transcripts on the audio turn speaker context", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "non-owner answer" }] });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { debounceMs: 1 } } },
      });
      const nonOwnerTurn = entry?.realtime?.beginSpeakerTurn(
        { extraSystemPrompt: undefined, senderIsOwner: false, speakerLabel: "Guest" },
        "u-guest",
      );
      nonOwnerTurn?.sendInputAudio(Buffer.alloc(8));

      await flushRealtimeForcedConsultTimers(() => {
        bridgeParams?.onTranscript?.("user", "non-owner question", true);
        const ownerTurn = entry?.realtime?.beginSpeakerTurn(
          { extraSystemPrompt: undefined, senderIsOwner: true, speakerLabel: "Owner" },
          "u-owner",
        );
        ownerTurn?.sendInputAudio(Buffer.alloc(8));
      });

      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
      expectUserMessageIncludes("non-owner answer");
    });

    it("routes active-run realtime transcripts to voice control before forced consults", async () => {
      controlRealtimeVoiceAgentRunMock.mockResolvedValueOnce({
        ok: true,
        mode: "cancel",
        sessionKey: "discord:g1:c1",
        sessionId: "embedded-active",
        active: true,
        aborted: true,
        message: "Cancelled the active OpenClaw run.",
        speak: true,
        show: true,
        suppress: false,
      });
      const { bridgeParams, player } = await createJoinedAgentProxyFixture();

      bridgeParams?.onTranscript?.("user", "cancel that", true);

      await vi.waitFor(() =>
        expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledWith({
          sessionKey: "discord:g1:c1",
          text: "cancel that",
        }),
      );
      expect(agentCommandMock).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(realtimeSessionMock.handleBargeIn).toHaveBeenCalledWith({
          audioPlaybackActive: true,
          force: true,
        }),
      );
      await vi.waitFor(() => expectUserMessageIncludes("Cancelled the active OpenClaw run."));
      expect(textToSpeechMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ text: "Cancelled the active OpenClaw run." }),
      );

      const stopCallsAfterControl = player.stop.mock.calls.length;
      bridgeParams?.onTranscript?.("assistant", "Cancelled the active OpenClaw run.", true);
      expect(player.stop).toHaveBeenCalledTimes(stopCallsAfterControl);
      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(24_000));
      bridgeParams?.onTranscript?.("assistant", "Cancelled the active OpenClaw run.", true);
      expect(player.stop).toHaveBeenCalledTimes(stopCallsAfterControl + 1);
    });

    it("keeps concurrent final transcripts bound to their original speakers", async () => {
      let resolveGuestControl: ((result: RealtimeVoiceAgentControlResult) => void) | undefined;
      controlRealtimeVoiceAgentRunMock.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveGuestControl = resolve;
        }),
      );
      agentCommandMock.mockResolvedValue({ payloads: [{ text: "talkback answer" }] });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture({
        config: {
          voice: { realtime: { debounceMs: 1, requireWakeName: false, toolPolicy: "none" } },
        },
      });

      beginSpeakerTurn(entry, {
        senderIsOwner: false,
        speakerLabel: "Alice",
        userId: "u-alice",
      });
      bridgeParams?.onTranscript?.("user", "OpenClaw, cancel that", true);
      await vi.waitFor(() => expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledTimes(1));

      beginSpeakerTurn(entry, {
        senderIsOwner: true,
        speakerLabel: "Bob",
        userId: "u-bob",
      });
      bridgeParams?.onTranscript?.("user", "OpenClaw, stop that", true);
      await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));

      resolveGuestControl?.({
        ok: false,
        mode: "cancel",
        sessionKey: "discord:g1:c1",
        active: false,
        queued: false,
        reason: "no_active_run",
        message: "There is no active OpenClaw run to cancel.",
        speak: true,
        show: true,
        suppress: false,
      });
      await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(2));

      const commandCalls = [agentCommandArgsAt(0), agentCommandArgsAt(1)];
      const aliceCall = commandCalls.find((args) => String(args.message).includes("cancel that"));
      const bobCall = commandCalls.find((args) => String(args.message).includes("stop that"));
      expect(aliceCall?.senderIsOwner).toBe(false);
      expect(bobCall?.senderIsOwner).toBe(true);
    });

    it("drops stale active-run control after provider continuity reset", async () => {
      let resolveOldControl: ((result: RealtimeVoiceAgentControlResult) => void) | undefined;
      controlRealtimeVoiceAgentRunMock
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveOldControl = resolve;
          }),
        )
        .mockResolvedValueOnce({
          ok: true,
          mode: "cancel",
          sessionKey: "discord:g1:c1",
          sessionId: "embedded-fresh",
          active: true,
          aborted: true,
          message: "Fresh control result.",
          speak: true,
          show: true,
          suppress: false,
        });
      const { bridgeParams } = await createJoinedAgentProxyFixture();
      bridgeParams?.onTranscript?.("user", "cancel that", true);
      await vi.waitFor(() => expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledTimes(1));

      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      resolveOldControl?.({
        ok: true,
        mode: "cancel",
        sessionKey: "discord:g1:c1",
        sessionId: "embedded-old",
        active: true,
        aborted: true,
        message: "Stale control result.",
        speak: true,
        show: true,
        suppress: false,
      });
      await Promise.resolve();
      await Promise.resolve();

      expectUserMessageNotIncludes("Stale control result.");
      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();

      bridgeParams?.onReady?.();
      bridgeParams?.onTranscript?.("user", "stop that", true);
      await vi.waitFor(() => expectUserMessageIncludes("Fresh control result."));
      expect(realtimeSessionMock.handleBargeIn).toHaveBeenCalledTimes(1);
    });

    it("replaces stale talkback work across provider continuity reset", async () => {
      let resolveOldTalkback: ((result: { payloads: Array<{ text: string }> }) => void) | undefined;
      agentCommandMock
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveOldTalkback = resolve;
          }),
        )
        .mockResolvedValueOnce({ payloads: [{ text: "fresh talkback" }] });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { debounceMs: 1, toolPolicy: "none" } } },
      });
      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "old question");
      await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));

      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      bridgeParams?.onReady?.();
      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "fresh question");

      await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expectUserMessageIncludes("fresh talkback"));
      resolveOldTalkback?.({ payloads: [{ text: "stale talkback" }] });
      await Promise.resolve();
      await Promise.resolve();
      expectUserMessageNotIncludes("stale talkback");
    });

    it("preserves realtime forced consults when no active run accepts steering", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "normal answer" }] });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture();
      beginSpeakerTurn(entry);

      await emitFinalRealtimeUserTranscript(bridgeParams, "normal question");

      expect(lastAgentCommandArgs().message).toContain("normal question");
      expectUserMessageIncludes("normal answer");
    });

    it("defaults to wake names only while multiple people share agent-proxy voice", async () => {
      const client = createClient();
      const ownerState = {
        guild_id: "g1",
        user_id: "u-owner",
        channel_id: "1001",
        member: { user: { id: "u-owner", username: "owner", bot: false } },
      };
      const agentState = {
        guild_id: "g1",
        user_id: "bot-user",
        channel_id: "1001",
        member: { user: { id: "bot-user", username: "molty", bot: true } },
      };
      const helperBotState = {
        guild_id: "g1",
        user_id: "helper-bot",
        channel_id: "1001",
        member: { user: { id: "helper-bot", username: "helper", bot: true } },
      };
      let voiceStates: Array<Record<string, unknown>> = [ownerState, agentState, helperBotState];
      configureVoiceStateGateway(client, () => voiceStates);
      const manager = createAgentProxyManager(
        client,
        { voice: { realtime: { consultPolicy: "auto" } } },
        {
          agents: {
            list: [{ id: "agent-1", identity: { name: "Molty" } }],
          },
        },
        "bot-user",
      );
      await manager.join({ guildId: "g1", channelId: "1001" });
      const entry = getSessionEntry(manager);
      const bridgeParams = lastRealtimeBridgeParams();
      const beginOwnerTurn = () => {
        beginSpeakerTurn(entry);
      };

      expect(bridgeParams.autoRespondToAudio).toBe(false);
      expect(bridgeParams.interruptResponseOnInputAudio).toBe(false);

      beginOwnerTurn();
      await emitFinalRealtimeUserTranscript(bridgeParams, "How is it going?");
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      expect(lastAgentCommandArgs().message).toContain("How is it going?");

      const friendState = {
        guild_id: "g1",
        user_id: "u-friend",
        channel_id: "1001",
        member: { user: { id: "u-friend", username: "friend", bot: false } },
      };
      voiceStates = [...voiceStates, friendState];
      await manager.handleVoiceStateUpdate(friendState as never, null);

      beginOwnerTurn();
      await emitFinalRealtimeUserTranscript(bridgeParams, "What is the plan?");
      expect(agentCommandMock).toHaveBeenCalledTimes(1);

      beginOwnerTurn();
      await emitFinalRealtimeUserTranscript(bridgeParams, "Molty, what is the plan?");
      expect(agentCommandMock).toHaveBeenCalledTimes(2);
      expect(lastAgentCommandArgs().message).toContain("what is the plan?");
      expect(lastAgentCommandArgs().message).not.toContain("Molty");

      voiceStates = voiceStates.filter((state) => state.user_id !== "u-friend");
      await manager.handleVoiceStateUpdate(
        { ...friendState, channel_id: null } as never,
        friendState as never,
      );

      beginOwnerTurn();
      await emitFinalRealtimeUserTranscript(bridgeParams, "Continue without a wake name.");
      expect(agentCommandMock).toHaveBeenCalledTimes(3);
      expect(lastAgentCommandArgs().message).toContain("Continue without a wake name.");
    });

    it("requires the agent wake name before realtime agent-proxy consults", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "wake answer" }] });
      const { entry, bridgeParams } = await createWakeNameFixture();

      expect(bridgeParams?.autoRespondToAudio).toBe(false);
      expect(bridgeParams?.interruptResponseOnInputAudio).toBe(false);
      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(48_000));

      beginSpeakerTurn(entry, { senderIsOwner: false });
      await emitFinalRealtimeUserTranscript(bridgeParams, "agent-1 how is it going");

      expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "Hey, Molty, how is it going");

      expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledWith({
        sessionKey: "discord:g1:c1",
        text: "how is it going",
      });
      expect(lastAgentCommandArgs().message).toContain("how is it going");
      expect(lastAgentCommandArgs().message).not.toContain("Molty");
      expect(lastAgentCommandArgs().message).not.toContain("Hey");
    });

    it("acknowledges leading wake names from partial realtime transcripts", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "wake answer" }] });
      const { entry, bridgeParams } = await createWakeNameFixture();

      beginSpeakerTurn(entry);
      bridgeParams?.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
      bridgeParams?.onTranscript?.("user", "Hey, Molty", false);

      expectUserMessageIncludes('Answer: "Yeah."');
      expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
      expect(agentCommandMock).not.toHaveBeenCalled();

      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
      await emitFinalRealtimeUserTranscript(bridgeParams, "Hey, Molty, how is it going");

      expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledWith({
        sessionKey: "discord:g1:c1",
        text: "how is it going",
      });
      expect(lastAgentCommandArgs().message).toContain("how is it going");
      expectUserMessageIncludes("wake answer");
    });

    it("does not carry partial wake-name state across provider continuity resets", async () => {
      const { entry, bridgeParams } = await createWakeNameFixture();
      const wakeAckCount = () =>
        sentUserMessages().filter((message) => message.includes('Answer: "Yeah."')).length;

      beginSpeakerTurn(entry);
      bridgeParams?.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
      bridgeParams?.onTranscript?.("user", "Hey, Mol", false);
      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      bridgeParams?.onTranscript?.("user", "ty", false);

      expect(wakeAckCount()).toBe(0);

      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      bridgeParams?.onReady?.();
      bridgeParams?.onTranscript?.("user", "Hey, Molty", false);
      expect(wakeAckCount()).toBe(1);
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
    });

    it("preserves the wake-name acknowledgement across provider continuity resets", async () => {
      const { entry, bridgeParams } = await createWakeNameFixture();
      const wakeAckCount = () =>
        sentUserMessages().filter((message) => message.includes('Answer: "')).length;

      beginSpeakerTurn(entry);
      bridgeParams?.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
      bridgeParams?.onTranscript?.("user", "Hey, Molty", false);
      expect(wakeAckCount()).toBe(1);
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });

      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      bridgeParams?.onReady?.();
      bridgeParams?.onTranscript?.("user", "Hey, Molty", false);
      expect(wakeAckCount()).toBe(1);

      bridgeParams?.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
      bridgeParams?.onTranscript?.("user", "Hey, Molty", false);
      expect(wakeAckCount()).toBe(2);
    });

    it("replays zero-audio exact speech once after provider reconnect readiness", async () => {
      agentCommandMock
        .mockResolvedValueOnce({ payloads: [{ text: "first answer" }] })
        .mockResolvedValueOnce({ payloads: [{ text: "second answer" }] });
      const { bridgeParams, entry, player } = await createJoinedAgentProxyFixture();

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "first question");
      await vi.waitFor(() => expectUserMessageIncludes("first answer"));
      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "second question");
      expectUserMessageNotIncludes("second answer");

      const stopCallsBeforeReset = player.stop.mock.calls.length;
      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      expectUserMessageNotIncludes("second answer");
      expect(player.stop).toHaveBeenCalledTimes(stopCallsBeforeReset + 1);
      expect(realtimeSessionMock.handleBargeIn).not.toHaveBeenCalled();
      expect(realtimeSessionMock.close).not.toHaveBeenCalled();

      // OpenAI's onReady fires once; automatic recovery reports this event instead.
      bridgeParams.onEvent?.({ direction: "client", type: "session.reconnect.ready" });
      expect(sentUserMessages().filter((message) => message.includes("first answer"))).toHaveLength(
        2,
      );
      expectUserMessageNotIncludes("second answer");
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
      expect(
        sentUserMessages().filter((message) => message.includes("second answer")),
      ).toHaveLength(1);
    });

    it("replays exact speech buffered below playback preroll after continuity reset", async () => {
      agentCommandMock
        .mockResolvedValueOnce({ payloads: [{ text: "first answer" }] })
        .mockResolvedValueOnce({ payloads: [{ text: "second answer" }] });
      const { bridgeParams, entry, player } = await createJoinedAgentProxyFixture();

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "first question");
      await vi.waitFor(() => expectUserMessageIncludes("first answer"));
      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
      expect(player.play).not.toHaveBeenCalled();
      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "second question");
      expectUserMessageNotIncludes("second answer");

      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      bridgeParams?.onReady?.();

      expect(sentUserMessages().filter((message) => message.includes("first answer"))).toHaveLength(
        2,
      );
      expectUserMessageNotIncludes("second answer");
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });
      expect(
        sentUserMessages().filter((message) => message.includes("second answer")),
      ).toHaveLength(1);
    });

    it("does not replay exact speech after Discord playback starts", async () => {
      agentCommandMock
        .mockResolvedValueOnce({ payloads: [{ text: "first answer" }] })
        .mockResolvedValueOnce({ payloads: [{ text: "second answer" }] });
      const { bridgeParams, entry, player } = await createJoinedAgentProxyFixture();

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "first question");
      await vi.waitFor(() => expectUserMessageIncludes("first answer"));
      for (let index = 0; index < 50; index += 1) {
        bridgeParams?.audioSink?.sendAudio(Buffer.alloc(480));
      }
      expect(player.play).toHaveBeenCalledOnce();
      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "second question");
      expectUserMessageNotIncludes("second answer");

      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      bridgeParams?.onEvent?.({ direction: "client", type: "session.continuity.reset" });
      bridgeParams?.onReady?.();

      expect(sentUserMessages().filter((message) => message.includes("first answer"))).toHaveLength(
        1,
      );
      expect(
        sentUserMessages().filter((message) => message.includes("second answer")),
      ).toHaveLength(1);
    });

    it.each(["continuity reset", "terminal close"] as const)(
      "drops stale native consult delivery after provider %s",
      async (transition) => {
        let resolveOld: ((result: { payloads: Array<{ text: string }> }) => void) | undefined;
        agentCommandMock
          .mockReturnValueOnce(
            new Promise((resolve) => {
              resolveOld = resolve;
            }),
          )
          .mockResolvedValueOnce({ payloads: [{ text: "fresh answer" }] });
        const fixture = await createJoinedAgentProxyFixture();
        const { manager } = fixture;
        let { bridgeParams, entry } = fixture;
        try {
          beginSpeakerTurn(entry);
          const oldSubmission = bridgeParams?.onToolCall?.(
            {
              itemId: "item-old",
              callId: "call-old",
              name: "openclaw_agent_consult",
              args: { question: "same question" },
            },
            realtimeSessionMock,
          );
          await Promise.resolve();

          if (transition === "terminal close") {
            bridgeParams.onClose?.("error");
          } else {
            bridgeParams.onEvent?.({ direction: "client", type: "session.continuity.reset" });
            bridgeParams.onEvent?.({ direction: "client", type: "session.reconnect.scheduled" });
          }
          resolveOld?.({ payloads: [{ text: "stale answer" }] });
          await oldSubmission;
          expect(
            realtimeSessionMock.submitToolResult.mock.calls.some(
              ([callId]) => callId === "call-old",
            ),
          ).toBe(false);

          if (transition === "terminal close") {
            expect(manager.status()).toEqual([]);
            await manager.join({ guildId: "g1", channelId: "1001" });
            entry = getSessionEntry(manager);
            bridgeParams = lastRealtimeBridgeParams();
          } else {
            expect(manager.status()).toHaveLength(1);
            expect(realtimeSessionMock.close).not.toHaveBeenCalled();
            expect(getSessionEntry(manager)).toBe(entry);
          }
          bridgeParams?.onReady?.();
          beginSpeakerTurn(entry);
          await bridgeParams?.onToolCall?.(
            {
              itemId: "item-fresh",
              callId: "call-fresh",
              name: "openclaw_agent_consult",
              args: { question: "same question" },
            },
            realtimeSessionMock,
          );
          expect(realtimeSessionMock.submitToolResult).toHaveBeenCalledWith("call-fresh", {
            text: "fresh answer",
          });
        } finally {
          await manager.destroy();
        }
      },
    );

    it("treats a bare wake name as an activation for the next realtime transcript", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "follow-up answer" }] });
      const onUtterance = vi.fn();
      const manager = createAgentProxyManager(
        undefined,
        { voice: { realtime: { consultPolicy: "auto", requireWakeName: true } } },
        {
          agents: {
            list: [{ id: "agent-1", identity: { name: "Molty" } }],
          },
        },
      );

      await manager.join({ guildId: "g1", channelId: "1001" });
      await manager.join(
        { guildId: "g1", channelId: "1001" },
        {
          transcripts: {
            sessionId: "notes-1",
            onUtterance,
          },
        },
      );
      const entry = getSessionEntry(manager);
      const bridgeParams = lastRealtimeBridgeParams();

      beginSpeakerTurn(entry, { extraSystemPrompt: "owner prompt" });
      await emitFinalRealtimeUserTranscript(bridgeParams, "Multy?");

      expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
      expect(agentCommandMock).not.toHaveBeenCalled();

      bridgeParams?.onTranscript?.("user", "What's your take on rebuilding everything?", true);

      await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledTimes(1));
      expect(controlRealtimeVoiceAgentRunMock).not.toHaveBeenCalled();
      expect(lastAgentCommandArgs().message).toContain(
        "What's your take on rebuilding everything?",
      );
      expect(lastAgentCommandArgs().message).not.toContain("Multy");
      expect(lastAgentCommandArgs().extraSystemPrompt).toBe("owner prompt");
      expectUserMessageIncludes("follow-up answer");
      await vi.waitFor(() =>
        expect(onUtterance).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: "notes-1",
            text: "What's your take on rebuilding everything?",
            speaker: { id: "u-owner", label: "Owner" },
          }),
        ),
      );
    });

    it("reuses recently ignored speaker context when wake-name consult has no pending turn", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "wake answer" }] });
      const { entry, bridgeParams } = await createWakeNameFixture();

      beginSpeakerTurn(entry, { extraSystemPrompt: "owner prompt" });

      await flushRealtimeForcedConsultTimers(() => {
        bridgeParams?.onTranscript?.("user", "room noise", true);
        bridgeParams?.onTranscript?.("user", "Molty, so", true);
        bridgeParams?.onTranscript?.("user", "Malty, what do you have to say?", true);
      });

      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      expect(lastAgentCommandArgs().message).toContain("what do you have to say?");
      expect(lastAgentCommandArgs().message).not.toContain("Malty");
      expect(lastAgentCommandArgs().extraSystemPrompt).toBe("owner prompt");
      expectUserMessageIncludes("wake answer");
    });

    it("accepts OpenClaw as a default wake name before realtime agent-proxy consults", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "openclaw wake answer" }] });
      const { entry, bridgeParams } = await createWakeNameFixture();

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "OpenClaw, how is it going");

      expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledWith({
        sessionKey: "discord:g1:c1",
        text: "how is it going",
      });
      expect(lastAgentCommandArgs().message).toContain("how is it going");
      expect(lastAgentCommandArgs().message).not.toContain("OpenClaw");
      expectUserMessageIncludes("openclaw wake answer");
    });

    it("ignores default agent wake names longer than two words", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "fallback wake answer" }] });
      const { entry, bridgeParams } = await createWakeNameFixture("Claw Bot Helper");

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "Claw Bot Helper, should not wake");

      expect(agentCommandMock).not.toHaveBeenCalled();

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "OpenClaw, fallback still wakes");

      expect(lastAgentCommandArgs().message).toContain("fallback still wakes");
      expect(lastAgentCommandArgs().message).not.toContain("OpenClaw");
      expectUserMessageIncludes("fallback wake answer");
    });

    it.each([
      ["Monty", "Monty, are you with us?", "are you with us?"],
      ["Moti", "Moti, what's going on today?", "what's going on today?"],
      ["Multi", "Multi, step through the maintainer queue.", "step through the maintainer queue."],
      ["Marty", "Marty, can you hear me?", "can you hear me?"],
      ["Open claw", "Open claw can you still hear me?", "can you still hear me?"],
      ["Open Club", "Open Club, can you hear me now?", "can you hear me now?"],
      ["Open Cloud", "Open Cloud, can you hear me too?", "can you hear me too?"],
      ["Molty", "Can you still hear trailing, Molty.", "Can you still hear trailing"],
      ["Malty", "What's going on today, Malty?", "What's going on today"],
    ])("accepts fuzzy wake name %s", async (wakeName, transcript, expectedMessage) => {
      const { entry, bridgeParams } = await createWakeNameFixture();
      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, transcript);

      expect(lastAgentCommandArgs().message).toContain(expectedMessage);
      expect(lastAgentCommandArgs().message).not.toContain(wakeName);
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      "This is a multi-step maintainer problem.",
      "I asked multi about this already.",
      "Open law is not the wake phrase.",
      "I miss the nonsensical German ranting from Multy.",
      "Open chat, can you hear me now?",
    ])("rejects non-wake fuzzy phrase: %s", async (transcript) => {
      const { entry, bridgeParams } = await createWakeNameFixture();
      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, transcript);

      expect(agentCommandMock).not.toHaveBeenCalled();
    });

    it("leaves non-OpenAI agent-proxy realtime auto-response enabled when wake names are requested", async () => {
      resolveConfiguredRealtimeVoiceProviderMock.mockReturnValueOnce({
        provider: { id: "google" },
        providerConfig: { model: "gemini-live", voice: "default" },
      });
      const { bridgeParams } = await createJoinedAgentProxyFixture({
        config: {
          voice: {
            realtime: { provider: "google", consultPolicy: "auto", requireWakeName: true },
          },
        },
      });

      expect(bridgeParams?.autoRespondToAudio).toBe(true);
      expect(bridgeParams?.interruptResponseOnInputAudio).toBe(true);
    });

    it("uses configured wake names before realtime agent-proxy consults", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "configured wake answer" }] });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture({
        config: {
          voice: {
            realtime: {
              consultPolicy: "auto",
              requireWakeName: true,
              wakeNames: ["Claw", "Claw Bot", "Okay Google"],
            },
          },
        },
      });
      beginSpeakerTurn(entry);

      await emitFinalRealtimeUserTranscript(bridgeParams, "Claw Bot, ship it");

      expect(lastAgentCommandArgs().message).toContain("ship it");
      expect(lastAgentCommandArgs().message).not.toContain("Claw");
      expect(lastAgentCommandArgs().message).not.toContain("Bot");
      expectUserMessageIncludes("configured wake answer");

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "Okay Google, try the opener name");

      expect(lastAgentCommandArgs().message).toContain("try the opener name");
      expect(lastAgentCommandArgs().message).not.toContain("Okay");
      expect(lastAgentCommandArgs().message).not.toContain("Google");
      expect(agentCommandMock).toHaveBeenCalledTimes(2);
    });

    it("does not accept configured realtime wake names longer than two words", async () => {
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture({
        config: {
          voice: {
            realtime: {
              consultPolicy: "auto",
              requireWakeName: true,
              wakeNames: ["Claw Bot Helper"],
            },
          },
        },
      });
      beginSpeakerTurn(entry);

      await emitFinalRealtimeUserTranscript(bridgeParams, "Claw Bot Helper, ship it");

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "OpenClaw, ship it");

      expect(agentCommandMock).not.toHaveBeenCalled();
    });

    it("lets status questions fall back to normal realtime handling when no run is active", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "status answer" }] });
      controlRealtimeVoiceAgentRunMock.mockResolvedValueOnce({
        ok: true,
        mode: "status",
        sessionKey: "discord:g1:c1",
        active: false,
        message: "I'm not working on an active request right now.",
        speak: true,
        show: true,
        suppress: false,
      });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture();
      beginSpeakerTurn(entry);

      await emitFinalRealtimeUserTranscript(bridgeParams, "how is it going");

      expect(controlRealtimeVoiceAgentRunMock).toHaveBeenCalledWith({
        sessionKey: "discord:g1:c1",
        text: "how is it going",
      });
      expect(lastAgentCommandArgs().message).toContain("how is it going");
      expectUserMessageIncludes("status answer");
    });

    it("keeps separate forced agent-proxy fallback timers for rapid transcripts", async () => {
      agentCommandMock
        .mockResolvedValueOnce({ payloads: [{ text: "guest answer" }] })
        .mockResolvedValueOnce({ payloads: [{ text: "owner answer" }] });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture();

      beginSpeakerTurn(entry, { senderIsOwner: false });

      beginSpeakerTurn(entry);
      await flushRealtimeForcedConsultTimers(() => {
        bridgeParams?.onTranscript?.("user", "guest question", true);
        bridgeParams?.onTranscript?.("user", "owner question", true);
      });
      bridgeParams?.onEvent?.({ direction: "server", type: "response.done" });

      const guestCommandArgs = agentCommandArgsAt(0);
      expect(guestCommandArgs.message).toContain("guest question");
      const ownerCommandArgs = agentCommandArgsAt(1);
      expect(ownerCommandArgs.message).toContain("owner question");
      expectUserMessageIncludes("guest answer");
      expectUserMessageIncludes("owner answer");
    });

    it("skips incomplete and non-actionable forced agent-proxy transcripts", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "valid answer" }] });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture();

      beginSpeakerTurn(entry);

      beginSpeakerTurn(entry);
      await flushRealtimeForcedConsultTimers(() => {
        bridgeParams?.onTranscript?.("user", "Get this working and...", true);
        bridgeParams?.onTranscript?.("user", "I'll be right back. See you guys. Bye-bye.", true);
      });
      expect(agentCommandMock).not.toHaveBeenCalled();

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "ship it.");
      expect(lastAgentCommandArgs().message).toContain("ship it.");
      expectUserMessageIncludes("valid answer");
    });

    it("keeps forced agent-proxy fallback diagnostics out of agent prompts", async () => {
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "Could you repeat that?" }] });
      const { bridgeParams, entry } = await createJoinedAgentProxyFixture();

      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(bridgeParams, "What?");

      expect(lastAgentCommandArgs().message).toBe("What?");
      expect(lastAgentCommandArgs().message).not.toContain("consultPolicy");
      expect(lastAgentCommandArgs().message).not.toContain("openclaw_agent_consult");
      expectUserMessageIncludes("Could you repeat that?");
    });
  },
);
