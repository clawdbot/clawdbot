import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { setDiscordTranscriptsVoiceManager } from "./transcripts-source.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    createConnectionMock,
    joinVoiceChannelMock,
    entersStateMock,
    createAudioPlayerMock,
    resolveRealtimeBootstrapContextInstructionsMock,
    createRealtimeVoiceBridgeSessionMock,
    realtimeSessionMock,
    createManager,
    createAgentProxyManager,
    expectConnectedStatus,
    getSessionEntry,
    getVoiceReceive,
    createJoinedAgentProxyFixture,
    startTranscripts,
    stopTranscripts,
    beginSpeakerTurn,
    lastRealtimeBridgeParams,
    emitFinalRealtimeUserTranscript,
    receiveRecordedSpeech,
    transcribeAudioFileMock,
    agentCommandMock,
    makeVoiceConfig,
    emitDecryptFailure,
    createClient,
    configureVoiceStateGateway,
    enqueueSystemEventMock,
    updateVoiceState,
  }) => {
    it.each(
      (["manager replacement", "receive recovery"] as const).flatMap((phase) =>
        (["ready", "stopped", "reopened"] as const).map((outcome) => ({ phase, outcome })),
      ),
    )(
      "transfers the source subscription while $phase is still connecting ($outcome)",
      async ({ phase, outcome }) => {
        const original = createAgentProxyManager(undefined, { allowFrom: ["discord:u-owner"] });
        const firstNotes = vi.fn();
        const secondNotes = vi.fn();
        const reopenedNotes = vi.fn();
        expect(await startTranscripts(original, firstNotes)).toMatchObject({ ok: true });
        const manager =
          phase === "manager replacement"
            ? createAgentProxyManager(undefined, { allowFrom: ["discord:u-owner"] })
            : original;
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const connecting = createDeferred<void>();
        const ready = createDeferred<undefined>();
        entersStateMock.mockImplementationOnce(() => {
          connecting.resolve();
          return ready.promise;
        });
        const joins = vi.spyOn(manager, "join");
        try {
          if (phase === "manager replacement") {
            setDiscordTranscriptsVoiceManager({ accountId: "default", manager });
          } else {
            emitDecryptFailure(manager);
            emitDecryptFailure(manager);
            emitDecryptFailure(manager);
          }
          await connecting.promise;
          expect(await startTranscripts(manager, secondNotes, "replacement")).toMatchObject({
            ok: true,
          });
          if (outcome !== "ready") {
            expect(await stopTranscripts("replacement")).toMatchObject({ ok: true });
          }
          const reopened =
            outcome === "reopened"
              ? startTranscripts(manager, reopenedNotes, "reopened")
              : undefined;
          ready.resolve(undefined);
          expect(await joins.mock.results[0]!.value).toMatchObject({ ok: outcome === "ready" });
          if (reopened) {
            expect(await reopened).toMatchObject({ ok: true });
          }
          expect(joins).toHaveBeenCalledTimes(reopened ? 2 : 1);
          expect(joinVoiceChannelMock).toHaveBeenCalledTimes(reopened ? 3 : 2);
          expect(connection.destroy).toHaveBeenCalledTimes(outcome === "ready" ? 0 : 1);
          if (outcome === "stopped") {
            expect(manager.status()).toEqual([]);
            return;
          }
          expectConnectedStatus(manager, "1001");
          await receiveRecordedSpeech(manager, "the transferred source owns this note");
          expect(firstNotes).not.toHaveBeenCalled();
          expect(secondNotes).toHaveBeenCalledTimes(reopened ? 0 : 1);
          expect(reopenedNotes).toHaveBeenCalledTimes(reopened ? 1 : 0);
          expect(await stopTranscripts(reopened ? "reopened" : "replacement")).toMatchObject({
            ok: true,
          });
          expect(manager.status()).toEqual([]);
        } finally {
          ready.resolve(undefined);
          await Promise.allSettled(joins.mock.results.map((result) => result.value));
          joins.mockRestore();
          await manager.destroy();
          await original.destroy();
          setDiscordTranscriptsVoiceManager({
            accountId: "default",
            manager: null,
            expectedManager: manager,
          });
        }
      },
    );

    it.each(["during queued capture", "before fresh capture"])(
      "respects explicit leave %s behind an unresolved manual join",
      async (order) => {
        const client = createClient();
        const resolved = createDeferred<Awaited<ReturnType<typeof client.fetchChannel>>>();
        client.fetchChannel.mockImplementationOnce(() => resolved.promise);
        const manager = createManager(
          makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-owner"] }),
          client,
        );
        const manual = manager.join({ guildId: "g1", channelId: "1001" });
        expect(client.fetchChannel).toHaveBeenCalledOnce();
        const captureStart = vi.spyOn(manager, "startTranscriptsCapture");
        const sink = vi.fn();
        const capture =
          order === "during queued capture" ? startTranscripts(manager, sink) : undefined;
        try {
          if (capture) {
            await vi.waitFor(() => expect(captureStart).toHaveBeenCalledOnce());
          }
          expect(await manager.leave({ guildId: "g1" })).toMatchObject({ ok: true });
          resolved.resolve({
            id: "1001",
            guildId: "g1",
            type: 2,
            guild: { id: "g1", name: "Guild" },
          });
          expect(await manual).toMatchObject({ ok: false });
          if (capture) {
            expect(await capture).toMatchObject({ ok: false });
            expect(joinVoiceChannelMock).not.toHaveBeenCalled();
            expect(manager.status()).toEqual([]);
          }
          // A completed leave only cancels earlier intent, not a new request.
          expect(await startTranscripts(manager, sink, "fresh-notes")).toMatchObject({ ok: true });
          expectConnectedStatus(manager, "1001");
          await receiveRecordedSpeech(manager, "fresh capture note");
          expect(sink).toHaveBeenCalledOnce();
          expect(agentCommandMock).not.toHaveBeenCalled();
        } finally {
          resolved.resolve({
            id: "1001",
            guildId: "g1",
            type: 2,
            guild: { id: "g1", name: "Guild" },
          });
          await Promise.allSettled([manual, capture]);
          captureStart.mockRestore();
          await manager.destroy();
        }
      },
    );

    it.each(["capture-start", "recovery"])(
      "keeps the subscription when the room empties during %s",
      async (phase) => {
        const client = createClient();
        const human = {
          guild_id: "g1",
          channel_id: "1001",
          user_id: "u-owner",
          member: { user: { id: "u-owner", bot: false } },
        };
        let states: Array<Record<string, unknown>> = [human];
        configureVoiceStateGateway(client, () => states);
        const manager = createManager(
          makeVoiceConfig(
            {
              mode: "agent-proxy",
              autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }],
              realtime: { provider: "openai", requireWakeName: true },
            },
            { groupPolicy: "open" },
          ),
          client,
        );
        const onUtterance = vi.fn();
        if (phase === "recovery") {
          await manager.autoJoin();
          await startTranscripts(manager, onUtterance);
        }
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const ready = createDeferred<undefined>();
        entersStateMock.mockImplementationOnce(() => ready.promise);
        const start =
          phase === "capture-start" ? startTranscripts(manager, onUtterance) : undefined;
        if (phase === "recovery") {
          emitDecryptFailure(manager);
          emitDecryptFailure(manager);
          emitDecryptFailure(manager);
        }
        await vi.waitFor(() =>
          expect(joinVoiceChannelMock).toHaveBeenCalledTimes(phase === "recovery" ? 2 : 1),
        );
        states = [];
        const departure = updateVoiceState(manager, "u-owner", null, human.member);
        ready.resolve(undefined);
        if (start) {
          expect(await start).toMatchObject({ ok: true });
        }
        await departure;
        await vi.waitFor(() => expect(connection.destroy).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(manager.status()).toEqual([]));
        states = [human];
        await updateVoiceState(manager, "u-owner", "1001", human.member);
        await receiveRecordedSpeech(manager, "after returning to the room");
        expect(onUtterance).toHaveBeenCalledOnce();
      },
    );
    it.each(["capture-first", "restart"])(
      "keeps unrelated capture dormant beside configured conversation (%s)",
      async (order) => {
        const client = createClient();
        configureVoiceStateGateway(client, () => [
          {
            guild_id: "g1",
            channel_id: "1001",
            user_id: "u-owner",
            member: { user: { id: "u-owner", bot: false } },
          },
        ]);
        const config = makeVoiceConfig(
          {
            mode: "agent-proxy",
            autoJoin: [{ guildId: "g1", channelId: "1001", whenOccupied: true }],
            realtime: { provider: "openai", requireWakeName: true },
          },
          { groupPolicy: "open", allowFrom: ["discord:u-owner"] },
        );
        let manager = createManager(config, client);
        if (order === "restart") {
          await manager.autoJoin();
        }
        const onUtterance = vi.fn();
        expect(await startTranscripts(manager, onUtterance, "other-room", "1002")).toMatchObject({
          ok: true,
        });
        if (order === "restart") {
          const oldManager = manager;
          manager = createManager(config, client);
          setDiscordTranscriptsVoiceManager({ accountId: "default", manager });
          await oldManager.destroy();
        }
        try {
          await manager.autoJoin();
          expectConnectedStatus(manager, "1001");
          await receiveRecordedSpeech(manager, "not the capture channel");
          expect(onUtterance).not.toHaveBeenCalled();
          await manager.join({ guildId: "g1", channelId: "1002" });
          await receiveRecordedSpeech(manager, "the selected channel");
          expect(onUtterance).toHaveBeenCalledOnce();
          expect(await stopTranscripts("other-room", "1002")).toMatchObject({ ok: true });
          expectConnectedStatus(manager, "1002");
        } finally {
          await manager.destroy();
          setDiscordTranscriptsVoiceManager({
            accountId: "default",
            manager: null,
            expectedManager: manager,
          });
        }
      },
    );

    it("retires an uncommitted capture-only entry when its registration is replaced", async () => {
      const connection = createConnectionMock();
      connection.receiver.speaking.users.set("guest", Date.now());
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const client = createClient();
      configureVoiceStateGateway(client, () => []);
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-owner"] }),
        client,
      );
      const firstUtterance = vi.fn();
      const nextUtterance = vi.fn();
      let replacement: ReturnType<typeof startTranscripts> | undefined;
      enqueueSystemEventMock.mockImplementationOnce(() => {
        replacement = startTranscripts(manager, nextUtterance, "notes-2");
        return true;
      });
      expect(await startTranscripts(manager, firstUtterance)).toMatchObject({ ok: false });
      expect(await replacement).toMatchObject({ ok: true });
      expect(connection.receiver.subscribe).not.toHaveBeenCalled();
      expectConnectedStatus(manager, "1001");
      await receiveRecordedSpeech(manager);
      expect(firstUtterance).not.toHaveBeenCalled();
      expect(nextUtterance).toHaveBeenCalledOnce();
      expect(agentCommandMock).not.toHaveBeenCalled();
    });

    it.each([
      { channelId: "1002", outcome: "ready" },
      { channelId: "1001", outcome: "ready" },
      { channelId: "1002", outcome: "failed" },
      { channelId: "1002", outcome: "cancelled" },
      { channelId: "1002", outcome: "revoked capture" },
    ])(
      "reconciles registered capture recovery after newer $channelId join is $outcome",
      async ({ channelId, outcome }) => {
        const manager = createAgentProxyManager(undefined, { allowFrom: ["discord:u-owner"] });
        const onUtterance = vi.fn();
        await startTranscripts(manager, onUtterance);
        const captureEntry = getSessionEntry(manager);
        const capture = captureEntry.transcripts;
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        const ready = createDeferred<undefined>();
        entersStateMock.mockImplementationOnce(() => ready.promise);
        const joins = vi.spyOn(manager, "join");
        const leave = manager.leave.bind(manager);
        let manual: ReturnType<typeof manager.join> | undefined;
        const leaving = vi.spyOn(manager, "leave").mockImplementationOnce(async (...args) => {
          const result = await leave(...args);
          manual = manager.join({ guildId: "g1", channelId });
          return result;
        });
        try {
          emitDecryptFailure(manager);
          emitDecryptFailure(manager);
          emitDecryptFailure(manager);
          // Recovery has left its old transport and is now queued behind the newer join.
          await vi.waitFor(() => expect(joins).toHaveBeenCalledTimes(2));
          expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
          if (outcome === "revoked capture") {
            expect(await stopTranscripts()).toMatchObject({ ok: true });
          } else if (outcome === "cancelled") {
            expect(await manager.leave({ guildId: "g1" })).toMatchObject({ ok: true });
          }
          if (outcome === "failed") {
            ready.reject(new Error("synthetic ready failure"));
          } else {
            ready.resolve(undefined);
          }
          const manualSucceeded = outcome === "ready" || outcome === "revoked capture";
          expect(await manual).toMatchObject({ ok: manualSucceeded });
          expect(await joins.mock.results[1]!.value).toMatchObject({
            ok: outcome !== "revoked capture",
          });
          await vi.waitFor(() =>
            expect(captureEntry.receiveRecovery.decryptRecoveryInFlight).toBe(false),
          );
          captureEntry.stop();
          if (manualSucceeded) {
            expect(connection.destroy).not.toHaveBeenCalled();
            expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
            expectConnectedStatus(manager, channelId);
            expect(getSessionEntry(manager).connection).toBe(connection);
            expect(getSessionEntry(manager).realtimeLifecycle.status).toBe("active");
            await receiveRecordedSpeech(manager, "newer conversation");
            expect(realtimeSessionMock.sendAudio).toHaveBeenCalled();
            expect(onUtterance).toHaveBeenCalledTimes(channelId === "1001" ? 1 : 0);
            if (outcome === "ready") {
              if (channelId !== "1001") {
                // Only an ordinary manual join may move residency to the dormant capture.
                expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({
                  ok: true,
                });
                await receiveRecordedSpeech(manager, "original capture still registered");
              }
              expect(getSessionEntry(manager).transcripts).toBe(capture);
              expect(onUtterance).toHaveBeenCalledOnce();
              expect(await stopTranscripts()).toMatchObject({ ok: true });
              expectConnectedStatus(manager, "1001");
            }
          } else {
            expect(connection.destroy).toHaveBeenCalledOnce();
            expect(joinVoiceChannelMock).toHaveBeenCalledTimes(3);
            expectConnectedStatus(manager, "1001");
            expect(getSessionEntry(manager).transcripts).toBe(capture);
            expect(getSessionEntry(manager).realtimeLifecycle.status).toBe("inactive");
            await receiveRecordedSpeech(manager, "silent capture after failed newer join");
            expect(onUtterance).toHaveBeenCalledOnce();
            expect(agentCommandMock).not.toHaveBeenCalled();
            expect(await stopTranscripts()).toMatchObject({ ok: true });
            expect(manager.status()).toEqual([]);
          }
        } finally {
          ready.resolve(undefined);
          await Promise.allSettled(joins.mock.results.map((result) => result.value));
          leaving.mockRestore();
          joins.mockRestore();
        }
      },
    );

    it("does not let cancelled capture recovery fence a newer manual audio session", async () => {
      const manager = createAgentProxyManager();
      await startTranscripts(manager);
      const captureEntry = getSessionEntry(manager);
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const ready = createDeferred<undefined>();
      entersStateMock.mockImplementationOnce(() => ready.promise);
      const leave = manager.leave.bind(manager);
      let manual: ReturnType<typeof manager.join> | undefined;
      vi.spyOn(manager, "leave").mockImplementationOnce(async (...args) => {
        const result = await leave(...args);
        manual = manager.join({ guildId: "g1", channelId: "1001" });
        return result;
      });
      emitDecryptFailure(manager);
      emitDecryptFailure(manager);
      emitDecryptFailure(manager);
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
      expect(await stopTranscripts()).toMatchObject({ ok: true });
      ready.resolve(undefined);
      expect(await manual).toMatchObject({ ok: true });
      await vi.waitFor(() =>
        expect(captureEntry.receiveRecovery.decryptRecoveryInFlight).toBe(false),
      );
      await vi.waitFor(() => expectConnectedStatus(manager, "1001"));
      const entry = getSessionEntry(manager);
      beginSpeakerTurn(entry);
      await emitFinalRealtimeUserTranscript(
        lastRealtimeBridgeParams(),
        "OpenClaw, are you still listening?",
      );
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(connection.destroy).not.toHaveBeenCalled();
    });
    it("cancels a pending capture-only join without leaving an orphan connection", async () => {
      const manager = createAgentProxyManager();
      const connection = createConnectionMock();
      joinVoiceChannelMock.mockReturnValueOnce(connection);
      const ready = createDeferred<undefined>();
      entersStateMock.mockImplementationOnce(() => ready.promise);
      const starting = startTranscripts(manager);
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledOnce());
      expect(await stopTranscripts()).toMatchObject({ ok: true });
      ready.resolve(undefined);
      expect(await starting).toMatchObject({ ok: false });
      expect(connection.destroy).toHaveBeenCalledOnce();
      expect(manager.status()).toEqual([]);
    });

    it("keeps standalone capture silent across recovery and discards STT completing after stop", async () => {
      const manager = createManager(
        makeVoiceConfig(
          { mode: "agent-proxy" },
          { groupPolicy: "open", allowFrom: ["discord:u-owner"] },
        ),
      );
      const onUtterance = vi.fn();
      await startTranscripts(manager, onUtterance);
      const receiveSegment = () => receiveRecordedSpeech(manager);
      await receiveSegment();
      expect(onUtterance).toHaveBeenCalledOnce();
      emitDecryptFailure(manager);
      emitDecryptFailure(manager);
      emitDecryptFailure(manager);
      await vi.waitFor(() => expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2));
      await receiveSegment();
      expect(onUtterance).toHaveBeenCalledTimes(2);
      expect(createRealtimeVoiceBridgeSessionMock).not.toHaveBeenCalled();
      const stt = createDeferred<{ text: string }>();
      transcribeAudioFileMock.mockImplementationOnce(() => stt.promise);
      const pending = receiveSegment();
      await vi.waitFor(() => expect(transcribeAudioFileMock).toHaveBeenCalledTimes(3));
      expect(await stopTranscripts()).toMatchObject({ ok: true });
      stt.resolve({ text: "late STT" });
      await pending;
      expect(onUtterance).toHaveBeenCalledTimes(2);
      expect(agentCommandMock).not.toHaveBeenCalled();
      expect(manager.status()).toEqual([]);
    });
    it("rebinds capture to a replacement account manager and fences old cleanup", async () => {
      const config = {
        voice: {
          enabled: true,
          mode: "agent-proxy" as const,
          autoJoin: [{ guildId: "g1", channelId: "1001" }],
          realtime: { provider: "openai", requireWakeName: true },
        },
        groupPolicy: "open" as const,
      };
      const oldManager = createManager(config);
      await oldManager.autoJoin();
      const onUtterance = vi.fn();
      await startTranscripts(oldManager, onUtterance);
      const oldEntry = getSessionEntry(oldManager);
      const replacement = createManager(config);
      setDiscordTranscriptsVoiceManager({ accountId: "default", manager: replacement });
      await oldManager.destroy();
      setDiscordTranscriptsVoiceManager({
        accountId: "default",
        manager: null,
        expectedManager: oldManager,
      });
      try {
        await replacement.autoJoin();
        await receiveRecordedSpeech(replacement, "replacement manager note");
        expect(onUtterance).toHaveBeenCalledOnce();
        await receiveRecordedSpeech(oldManager, "stale manager", oldEntry);
        expect(onUtterance).toHaveBeenCalledOnce();
        expect(await stopTranscripts()).toMatchObject({ ok: true });
        expectConnectedStatus(replacement, "1001");
      } finally {
        await replacement.destroy();
        setDiscordTranscriptsVoiceManager({
          accountId: "default",
          manager: null,
          expectedManager: replacement,
        });
      }
    });

    it("stops an exact offline subscription and never reattaches it", async () => {
      const manager = createAgentProxyManager();
      const onUtterance = vi.fn();
      await startTranscripts(manager, onUtterance);
      const capture = getSessionEntry(manager).transcripts;
      await manager.destroy();
      setDiscordTranscriptsVoiceManager({
        accountId: "default",
        manager: null,
        expectedManager: manager,
      });
      expect(await stopTranscripts("notes-1", "1002")).toMatchObject({ ok: false });
      expect(await stopTranscripts()).toMatchObject({ ok: true });
      await capture?.onUtterance?.({ sessionId: "notes-1", text: "late note", final: true });
      expect(onUtterance).not.toHaveBeenCalled();
      const replacement = createAgentProxyManager();
      setDiscordTranscriptsVoiceManager({ accountId: "default", manager: replacement });
      try {
        await replacement.join({ guildId: "g1", channelId: "1001" });
        await receiveRecordedSpeech(replacement, "uncaptured note");
        expect(onUtterance).not.toHaveBeenCalled();
      } finally {
        await replacement.destroy();
        setDiscordTranscriptsVoiceManager({
          accountId: "default",
          manager: null,
          expectedManager: replacement,
        });
      }
    });
    it("attaches transcripts capture to an existing voice session", async () => {
      const manager = createManager(
        makeVoiceConfig({}, { groupPolicy: "open", allowFrom: ["discord:u-owner"] }),
      );

      await manager.join({ guildId: "g1", channelId: "1001" });
      const onUtterance = vi.fn();
      const result = await startTranscripts(manager, onUtterance, "notes-1");

      const entry = getSessionEntry(manager);
      expect(result.ok).toBe(true);
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      expect(entry.transcripts?.sessionId).toBe("notes-1");
      await receiveRecordedSpeech(manager);
      expect(onUtterance).toHaveBeenCalledOnce();
      expect(agentCommandMock).toHaveBeenCalledOnce();
      expect(await stopTranscripts()).toMatchObject({ ok: true });
      expectConnectedStatus(manager, "1001");
    });

    it("does not leave a newer transcripts-only session for a stale stop", async () => {
      const manager = createAgentProxyManager();
      const firstUtterance = vi.fn();
      const secondUtterance = vi.fn();

      await manager.join({ guildId: "g1", channelId: "1001" });
      await startTranscripts(manager, firstUtterance, "notes-1");
      const oldCapture = getSessionEntry(manager).transcripts;
      await startTranscripts(manager, secondUtterance, "notes-2");
      await oldCapture?.onUtterance?.({ text: "stale capture", final: true });
      expect(firstUtterance).not.toHaveBeenCalled();

      const result = await stopTranscripts("notes-1");
      const entry = getSessionEntry(manager);

      expect(result.ok).toBe(false);
      expect(entry.transcripts?.sessionId).toBe("notes-2");
      expectConnectedStatus(manager, "1001");
      await receiveRecordedSpeech(manager, "replacement capture");
      expect(secondUtterance).toHaveBeenCalledOnce();
    });

    it("upgrades a transcripts-only session to realtime on a normal join", async () => {
      const manager = createAgentProxyManager();
      const onUtterance = vi.fn();

      await startTranscripts(manager, onUtterance, "notes-1");
      expect(createRealtimeVoiceBridgeSessionMock).not.toHaveBeenCalled();
      expect(createAudioPlayerMock).toHaveBeenCalledWith({
        behaviors: { maxMissedFrames: 100 },
      });

      const entry = getSessionEntry(manager);
      expect(entry.realtimeLifecycle.status).toBe("inactive");
      const realtimeReady = createDeferred<undefined>();
      realtimeSessionMock.connect.mockImplementationOnce(() => realtimeReady.promise);

      const upgrade = manager.join({ guildId: "g1", channelId: "1001" });

      await vi.waitFor(() => expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(1));
      expect(entry.realtimeLifecycle.status).toBe("starting");

      realtimeReady.resolve(undefined);
      const result = await upgrade;

      expect(result.ok).toBe(true);
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(1);
      expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(1);
      expect(realtimeSessionMock.connect).toHaveBeenCalledTimes(1);
      expect(entry.transcripts?.sessionId).toBe("notes-1");
      expect(entry.realtimeLifecycle.status).toBe("active");
      const attempts = getVoiceReceive(manager).daveRecoveryAttempts;
      attempts.set("g1", Date.now());

      const stopNotesResult = await stopTranscripts("notes-1");

      expect(stopNotesResult.ok).toBe(true);
      expect(entry.transcripts).toBeUndefined();
      expect(entry.realtimeLifecycle.status).toBe("active");
      expect(realtimeSessionMock.close).not.toHaveBeenCalled();
      expect(attempts.has("g1")).toBe(true);
      expectConnectedStatus(manager, "1001");
    });

    it("closes a pending realtime upgrade if the voice entry stops before connect resolves", async () => {
      const manager = createAgentProxyManager();
      const onUtterance = vi.fn();

      await startTranscripts(manager, onUtterance, "notes-1");
      const entry = getSessionEntry(manager);
      const realtimeReady = createDeferred<undefined>();
      realtimeSessionMock.connect.mockImplementationOnce(() => realtimeReady.promise);

      const upgrade = manager.join({ guildId: "g1", channelId: "1001" });

      await vi.waitFor(() => expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(1));
      expect(entry.realtimeLifecycle.status).toBe("starting");

      entry.stop();
      expect(realtimeSessionMock.close).toHaveBeenCalled();
      expect(entry.realtimeLifecycle.status).toBe("stopped");

      realtimeReady.resolve(undefined);
      const result = await upgrade;

      expect(result.ok).toBe(false);
      expect(result.message).toContain("stopped before startup completed");
      expect(entry.realtimeLifecycle.status).toBe("stopped");
    });

    it.each(["bootstrap", "connect"])(
      "detaches transcripts without leaving voice during pending realtime upgrade (%s)",
      async (phase) => {
        const manager = createAgentProxyManager();
        const onUtterance = vi.fn();

        await startTranscripts(manager, onUtterance, "notes-1");
        const entry = getSessionEntry(manager);
        const realtimeReady = createDeferred<undefined>();
        const pending =
          phase === "bootstrap"
            ? resolveRealtimeBootstrapContextInstructionsMock
            : realtimeSessionMock.connect;
        pending.mockImplementationOnce(() => realtimeReady.promise);

        const upgrade = manager.join({ guildId: "g1", channelId: "1001" });

        await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce());
        const stopNotesResult = await stopTranscripts("notes-1");

        expect(stopNotesResult.ok).toBe(true);
        expect(entry.transcripts).toBeUndefined();
        expect(entry.realtimeLifecycle.status).toBe(
          phase === "bootstrap" ? "inactive" : "starting",
        );

        realtimeReady.resolve(undefined);
        const result = await upgrade;

        expect(result.ok).toBe(true);
        expect(entry.realtimeLifecycle.status).toBe("active");
        expectConnectedStatus(manager, "1001");
      },
    );

    it("does not start realtime upgrade if the voice entry leaves during bootstrap", async () => {
      const manager = createAgentProxyManager();
      const onUtterance = vi.fn();

      await startTranscripts(manager, onUtterance, "notes-1");
      const bootstrapReady = createDeferred<undefined>();
      resolveRealtimeBootstrapContextInstructionsMock.mockImplementationOnce(
        () => bootstrapReady.promise,
      );

      const upgrade = manager.join({ guildId: "g1", channelId: "1001" });
      await Promise.resolve();

      const leaveResult = await manager.leave({ guildId: "g1" });
      bootstrapReady.resolve(undefined);
      const result = await upgrade;

      expect(leaveResult.ok).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("stopped before startup completed");
      expect(createRealtimeVoiceBridgeSessionMock).not.toHaveBeenCalled();
    });

    it("keeps realtime playback alive when transcripts attaches to an existing voice session", async () => {
      const { bridgeParams, entry, manager, player } = await createJoinedAgentProxyFixture({
        config: { voice: { realtime: { consultPolicy: "auto" } } },
      });

      bridgeParams?.audioSink?.sendAudio(Buffer.alloc(24_000));
      const stopCallsBeforeTranscripts = player.stop.mock.calls.length;
      const onUtterance = vi.fn(async () => undefined);

      const result = await startTranscripts(manager, onUtterance, "notes-1");

      expect(result.ok).toBe(true);
      expect(entry.transcripts?.sessionId).toBe("notes-1");
      expect(realtimeSessionMock.close).not.toHaveBeenCalled();
      expect(player.stop).toHaveBeenCalledTimes(stopCallsBeforeTranscripts);

      await receiveRecordedSpeech(manager, "meeting note transcript");

      await vi.waitFor(() =>
        expect(onUtterance).toHaveBeenCalledWith(
          expect.objectContaining({
            final: true,
            sessionId: "notes-1",
            speaker: { id: "u-owner", label: "u-owner" },
            text: "meeting note transcript",
            metadata: expect.objectContaining({
              channel: "discord",
              channelId: "1001",
              guildId: "g1",
              voiceSessionKey: "discord:g1:c1",
            }),
          }),
        ),
      );
      expect(player.stop).toHaveBeenCalledTimes(stopCallsBeforeTranscripts);
    });
  },
);
