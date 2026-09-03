import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    agentCommandMock,
    agentCommandArgsAt,
    beginSpeakerTurn,
    createJoinedAgentProxyFixture,
    createRealtimeSessionMock,
    createRealtimeVoiceBridgeSessionMock,
    emitFinalRealtimeUserTranscript,
    lastAgentCommandArgs,
    lastRealtimeBridge,
    sentUserMessages,
  }) => {
    it.each(["guest-first", "owner-first"] as const)(
      "keeps speaker authority and transcript labels with their input connections: %s",
      async (order) => {
        const { entry, manager } = await createJoinedAgentProxyFixture({
          config: { voice: { realtime: { requireWakeName: false } } },
        });
        const onUtterance = vi.fn();
        try {
          await manager.join(
            { guildId: "g1", channelId: "1001" },
            { transcripts: { sessionId: "shared-room", onUtterance } },
          );
          beginSpeakerTurn(entry, {
            userId: "guest",
            speakerLabel: "Ada",
            senderIsOwner: false,
            extraSystemPrompt: "Guest room context.",
          }).close();
          const guest = lastRealtimeBridge();
          beginSpeakerTurn(entry, {
            userId: "owner",
            speakerLabel: "Grace",
            senderIsOwner: true,
            extraSystemPrompt: "Owner room context.",
          }).close();
          const owner = lastRealtimeBridge();
          const turns = [
            {
              source: guest,
              text: "Summarize the agenda.",
              id: "guest",
              label: "Ada",
              owner: false,
              prompt: "Guest room context.",
            },
            {
              source: owner,
              text: "Read the next appointment.",
              id: "owner",
              label: "Grace",
              owner: true,
              prompt: "Owner room context.",
            },
          ];
          if (order === "owner-first") {
            turns.reverse();
          }
          for (const [index, turn] of turns.entries()) {
            await emitFinalRealtimeUserTranscript(turn.source.bridgeParams, turn.text);
            expect(agentCommandArgsAt(index)).toMatchObject({
              senderIsOwner: turn.owner,
              extraSystemPrompt: turn.prompt,
              agentId: "agent-1",
              sessionKey: "discord:g1:c1",
            });
            expect(onUtterance).toHaveBeenCalledWith(
              expect.objectContaining({
                sessionId: "shared-room",
                text: turn.text,
                speaker: { id: turn.id, label: turn.label },
              }),
            );
          }
          expect(agentCommandMock).toHaveBeenCalledTimes(2);
        } finally {
          await manager.destroy();
        }
      },
    );

    it("does not let a silent speaker consume another speaker's pending audio", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: false } } },
      });
      try {
        beginSpeakerTurn(entry).close();
        const owner = lastRealtimeBridge();
        beginSpeakerTurn(entry, { senderIsOwner: false, initialAudio: null }).close();
        const silentGuest = lastRealtimeBridge();
        await emitFinalRealtimeUserTranscript(silentGuest.bridgeParams, "Unbound transcript.");
        expect(agentCommandMock).not.toHaveBeenCalled();
        await emitFinalRealtimeUserTranscript(owner.bridgeParams, "Read my agenda.");
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(lastAgentCommandArgs().senderIsOwner).toBe(true);
      } finally {
        await manager.destroy();
      }
    });

    it("retains one speaker's authority across multiple final transcripts from one capture", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: false } } },
      });
      try {
        beginSpeakerTurn(entry, {
          senderIsOwner: false,
          extraSystemPrompt: "Guest context.",
        }).close();
        const guest = lastRealtimeBridge();
        await emitFinalRealtimeUserTranscript(guest.bridgeParams, "Read the agenda.");
        await emitFinalRealtimeUserTranscript(guest.bridgeParams, "Then summarize the notes.");
        expect(agentCommandMock).toHaveBeenCalledTimes(2);
        for (const index of [0, 1]) {
          expect(agentCommandArgsAt(index)).toMatchObject({
            senderIsOwner: false,
            extraSystemPrompt: "Guest context.",
          });
        }
      } finally {
        await manager.destroy();
      }
    });

    it("keeps a wake-name follow-up available to its speaker after another person speaks", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: true } } },
      });
      try {
        beginSpeakerTurn(entry).close();
        const owner = lastRealtimeBridge();
        await emitFinalRealtimeUserTranscript(owner.bridgeParams, "OpenClaw");
        beginSpeakerTurn(entry, { senderIsOwner: false }).close();
        const guest = lastRealtimeBridge();
        await emitFinalRealtimeUserTranscript(guest.bridgeParams, "A separate conversation.");
        expect(agentCommandMock).not.toHaveBeenCalled();
        await emitFinalRealtimeUserTranscript(owner.bridgeParams, "Read my agenda.");
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(lastAgentCommandArgs().senderIsOwner).toBe(true);
      } finally {
        await manager.destroy();
      }
    });

    it("refreshes descriptive context without replacing the speaker's connection", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: false } } },
      });
      try {
        beginSpeakerTurn(entry, {
          senderIsOwner: false,
          speakerLabel: "Ada",
          extraSystemPrompt: "Old roster.",
        }).close();
        const guest = lastRealtimeBridge();
        await emitFinalRealtimeUserTranscript(guest.bridgeParams, "First question.");
        beginSpeakerTurn(entry, {
          senderIsOwner: false,
          speakerLabel: "Ada Lovelace",
          extraSystemPrompt: "Updated roster.",
        }).close();
        await emitFinalRealtimeUserTranscript(guest.bridgeParams, "Second question.");
        expect(guest.session.close).not.toHaveBeenCalled();
        expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledOnce();
        expect(lastAgentCommandArgs()).toMatchObject({
          senderIsOwner: false,
          extraSystemPrompt: "Updated roster.",
        });
      } finally {
        await manager.destroy();
      }
    });

    it("drops late transcript and tool callbacks when a speaker's admission changes", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: false } } },
      });
      try {
        beginSpeakerTurn(entry, { userId: "same-user", senderIsOwner: false }).close();
        const retired = lastRealtimeBridge();
        beginSpeakerTurn(entry, { userId: "same-user", senderIsOwner: true }).close();
        const owner = lastRealtimeBridge();
        expect(retired.session.close).toHaveBeenCalledOnce();
        await emitFinalRealtimeUserTranscript(retired.bridgeParams, "Stale guest question.");
        await retired.bridgeParams.onToolCall?.(
          {
            itemId: "old-item",
            callId: "old-call",
            name: "openclaw_agent_consult",
            args: { question: "Stale guest tool call." },
          },
          retired.session,
        );
        expect(agentCommandMock).not.toHaveBeenCalled();
        await emitFinalRealtimeUserTranscript(owner.bridgeParams, "Fresh owner question.");
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(lastAgentCommandArgs().senderIsOwner).toBe(true);
      } finally {
        await manager.destroy();
      }
    });

    it("delivers an in-flight reply through its original connection after a transcript subscription changes", async () => {
      const answer = createDeferred<{ payloads: Array<{ text: string }> }>();
      agentCommandMock.mockReturnValueOnce(answer.promise);
      const { entry, manager } = await createJoinedAgentProxyFixture();
      const oldTranscript = vi.fn();
      const newTranscript = vi.fn();
      let pending: Promise<void> | void = undefined;
      try {
        await manager.join(
          { guildId: "g1", channelId: "1001" },
          {
            transcripts: { sessionId: "old-subscription", onUtterance: oldTranscript },
          },
        );
        const originalCapture = beginSpeakerTurn(entry);
        const original = lastRealtimeBridge();
        pending = original.bridgeParams.onToolCall?.(
          {
            itemId: "old-item",
            callId: "old-call",
            name: "openclaw_agent_consult",
            args: { question: "Original question." },
          },
          original.session,
        );
        await vi.waitFor(() => expect(agentCommandMock).toHaveBeenCalledOnce());
        await manager.join(
          { guildId: "g1", channelId: "1001" },
          {
            transcripts: { sessionId: "new-subscription", onUtterance: newTranscript },
          },
        );
        beginSpeakerTurn(entry).close();
        const replacement = lastRealtimeBridge();
        const sentBeforeLateAudio = original.session.sendAudio.mock.calls.length;
        originalCapture.sendInputAudio(Buffer.alloc(8));
        expect(original.session.sendAudio).toHaveBeenCalledTimes(sentBeforeLateAudio);
        expect(original.session.close).not.toHaveBeenCalled();
        answer.resolve({ payloads: [{ text: "Original answer." }] });
        await pending;
        expect(original.session.submitToolResult).toHaveBeenCalledWith("old-call", {
          text: "Original answer.",
        });
        expect(replacement.session.submitToolResult).not.toHaveBeenCalled();
        await emitFinalRealtimeUserTranscript(replacement.bridgeParams, "Fresh question.");
        expect(newTranscript).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: "new-subscription", text: "Fresh question." }),
        );
        expect(oldTranscript).not.toHaveBeenCalled();
        expect(agentCommandMock).toHaveBeenCalledTimes(2);
      } finally {
        answer.resolve({ payloads: [] });
        await pending;
        await manager.destroy();
      }
    });

    it("keeps a healthy speaker connected when another speaker's provider connection fails", async () => {
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: false } } },
      });
      try {
        beginSpeakerTurn(entry).close();
        const owner = lastRealtimeBridge();
        const failed = createRealtimeSessionMock();
        failed.connect.mockRejectedValueOnce(new Error("provider unavailable"));
        createRealtimeVoiceBridgeSessionMock.mockReturnValueOnce(failed);
        beginSpeakerTurn(entry, { senderIsOwner: false }).close();
        await vi.waitFor(() => expect(failed.close).toHaveBeenCalled());
        expect(owner.session.close).not.toHaveBeenCalled();
        expect(manager.status()).toHaveLength(1);
        expect(
          sentUserMessages(owner.session).some((message) =>
            message.includes("Please try speaking again"),
          ),
        ).toBe(true);
        await emitFinalRealtimeUserTranscript(owner.bridgeParams, "Read my agenda.");
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(lastAgentCommandArgs().senderIsOwner).toBe(true);
      } finally {
        await manager.destroy();
      }
    });

    it("reclaims expired noise-only speakers without giving late callbacks a replacement's authority", async () => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const { entry, manager } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { requireWakeName: false } } },
      });
      try {
        for (let index = 0; index < 8; index += 1) {
          beginSpeakerTurn(entry, { userId: `guest-${index}`, senderIsOwner: false }).close();
        }
        const retired = lastRealtimeBridge();
        expect(() => beginSpeakerTurn(entry, { userId: "owner", senderIsOwner: true })).toThrow(
          "Voice is busy",
        );
        clock.mockReturnValue(now + 60_001);
        beginSpeakerTurn(entry, { userId: "owner", senderIsOwner: true }).close();
        const owner = lastRealtimeBridge();
        expect(retired.session.close).toHaveBeenCalledOnce();
        await emitFinalRealtimeUserTranscript(retired.bridgeParams, "Expired guest question.");
        expect(agentCommandMock).not.toHaveBeenCalled();
        await emitFinalRealtimeUserTranscript(owner.bridgeParams, "Fresh owner question.");
        expect(agentCommandMock).toHaveBeenCalledOnce();
        expect(lastAgentCommandArgs().senderIsOwner).toBe(true);
      } finally {
        clock.mockRestore();
        await manager.destroy();
      }
    });
  },
);
