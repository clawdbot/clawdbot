import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { DiscordError } from "../internal/discord.js";
import {
  discordVoiceTranscriptsSourceProvider,
  setDiscordTranscriptsVoiceManager,
} from "./transcripts-source.js";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(
  ({
    expect,
    it,
    vi,
    ChannelType,
    createClient,
    createManager,
    createConnectionMock,
    entersStateMock,
    makeVoiceConfig,
    configureVoiceStateGateway,
    joinVoiceChannelMock,
    createRealtimeVoiceBridgeSessionMock,
    realtimeSessionMock,
    getSessionEntry,
    startTranscripts,
    stopTranscripts,
    receiveRecordedSpeech,
  }) => {
    type Residency = "live" | "other autoJoin" | "empty autoJoin" | "unknown autoJoin";
    const source = {
      providerId: "discord-voice",
      accountId: "default",
      guildId: "g1",
      channelId: "1002",
    };
    async function fixture(residency: Residency) {
      const client = createClient();
      const states: Array<Record<string, unknown>> = [];
      if (residency !== "unknown autoJoin") {
        configureVoiceStateGateway(client, () => states);
      }
      const manager = createManager(
        makeVoiceConfig(
          {
            mode: "agent-proxy",
            ...(residency !== "live"
              ? {
                  autoJoin: [
                    {
                      guildId: "g1",
                      channelId: residency === "other autoJoin" ? "1001" : "1002",
                      whenOccupied: true,
                    },
                  ],
                }
              : {}),
          },
          { groupPolicy: "open", allowFrom: ["discord:u-owner"] },
        ),
        client,
      );
      const preservedNotes = vi.fn();
      if (residency === "live") {
        expect(await manager.join({ guildId: "g1", channelId: "1001" })).toMatchObject({
          ok: true,
        });
        expect(await startTranscripts(manager, preservedNotes, "preserved")).toMatchObject({
          ok: true,
        });
      }
      const entry = residency === "live" ? getSessionEntry(manager) : undefined;
      const snapshot = entry ? { ...entry } : undefined;
      if (snapshot) {
        delete snapshot.transcripts;
      }
      const connection = joinVoiceChannelMock.mock.results.at(-1)?.value;
      const joins = joinVoiceChannelMock.mock.calls.length;
      const bridges = createRealtimeVoiceBridgeSessionMock.mock.calls.length;
      const assertResidencyPreserved = () => {
        expect(joinVoiceChannelMock).toHaveBeenCalledTimes(joins);
        expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledTimes(bridges);
        if (entry) {
          expect(getSessionEntry(manager)).toBe(entry);
          expect(entry).toMatchObject(snapshot!);
          expect(connection?.destroy).not.toHaveBeenCalled();
          expect(manager.status()).toMatchObject([{ channelId: "1001" }]);
        } else {
          expect(manager.status()).toEqual([]);
        }
      };
      return {
        client,
        manager,
        preservedNotes,
        assertResidencyPreserved,
        states,
        entry,
        connection,
      };
    }

    it.each(["live", "other autoJoin", "empty autoJoin"] as const)(
      "transfers a registered dormant capture during a Discord lookup outage (%s)",
      async (residency) => {
        const { client, manager, assertResidencyPreserved } = await fixture(residency);
        const originalFetch = client.fetchChannel.getMockImplementation()!;
        const firstNotes = vi.fn();
        const secondNotes = vi.fn();
        const firstStatus = vi.fn();
        const secondStatus = vi.fn();
        setDiscordTranscriptsVoiceManager({ accountId: "default", manager });
        const start = (
          sessionId: string,
          onUtterance: typeof firstNotes,
          onStatus: typeof firstStatus,
        ) =>
          discordVoiceTranscriptsSourceProvider.start!({
            session: { sessionId, source, startedAt: new Date().toISOString() },
            onUtterance,
            onStatus,
          });
        try {
          expect(await start("first-dormant", firstNotes, firstStatus)).toMatchObject({ ok: true });
          assertResidencyPreserved();
          client.fetchChannel.mockRejectedValue(new Error("synthetic Discord lookup outage"));
          expect(await start("second-dormant", secondNotes, secondStatus)).toMatchObject({
            ok: true,
          });
          expect(firstStatus).toHaveBeenCalledExactlyOnceWith({
            active: false,
            sessionId: "first-dormant",
            source,
          });
          expect(await stopTranscripts("first-dormant", "1002")).toMatchObject({ ok: false });
          expect(await discordVoiceTranscriptsSourceProvider.status!(source)).toMatchObject([
            { active: true, sessionId: "second-dormant" },
          ]);
          assertResidencyPreserved();

          client.fetchChannel.mockImplementation(originalFetch);
          expect(await manager.join({ guildId: "g1", channelId: "1002" })).toMatchObject({
            ok: true,
          });
          await receiveRecordedSpeech(manager, "the replacement owns this note");
          expect(firstNotes).not.toHaveBeenCalled();
          expect(secondNotes).toHaveBeenCalledOnce();
          expect(await stopTranscripts("second-dormant", "1002")).toMatchObject({ ok: true });
          expect(secondStatus).toHaveBeenCalledOnce();
          expect(await discordVoiceTranscriptsSourceProvider.status!(source)).toEqual([]);
        } finally {
          client.fetchChannel.mockImplementation(originalFetch);
          await stopTranscripts("first-dormant", "1002");
          await stopTranscripts("second-dormant", "1002");
          setDiscordTranscriptsVoiceManager({
            accountId: "default",
            manager: null,
            expectedManager: manager,
          });
        }
      },
    );

    it("does not retain a stopped capture's late fatal autoJoin failure", async () => {
      const manager = createManager(
        makeVoiceConfig({
          mode: "agent-proxy",
          autoJoin: [{ guildId: "g1", channelId: "1002" }],
        }),
      );
      const entered = createDeferred<void>();
      const connect = createDeferred<void>();
      realtimeSessionMock.connect.mockImplementationOnce(async () => {
        entered.resolve();
        await connect.promise;
      });
      const starting = startTranscripts(manager, vi.fn(), "stopped-autoJoin", "1002");
      await entered.promise;
      expect(await stopTranscripts("stopped-autoJoin", "1002")).toMatchObject({ ok: true });
      connect.reject(new Error("forbidden synthetic startup"));
      expect(await starting).toMatchObject({ ok: false });
      expect(manager.status()).toEqual([]);
      expect(await discordVoiceTranscriptsSourceProvider.status!(source)).toEqual([]);

      await manager.autoJoin();
      expect(manager.status()).toMatchObject([{ channelId: "1002" }]);
      expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
    });

    it.each([
      { whenOccupied: undefined, transition: "none" },
      { whenOccupied: false, transition: "none" },
      { whenOccupied: true, transition: "none" },
      { whenOccupied: false, transition: "stop" },
      { whenOccupied: false, transition: "replacement" },
      { whenOccupied: false, transition: "leave" },
    ])(
      "preserves capture autoJoin ownership (whenOccupied=$whenOccupied, $transition)",
      async ({ whenOccupied, transition }) => {
        const client = createClient();
        configureVoiceStateGateway(client, () => [
          {
            guild_id: "g1",
            channel_id: "1002",
            user_id: "u-owner",
            member: { user: { id: "u-owner", bot: false } },
          },
        ]);
        const manager = createManager(
          makeVoiceConfig(
            {
              mode: "agent-proxy",
              autoJoin: [
                {
                  guildId: "g1",
                  channelId: "1002",
                  ...(whenOccupied === undefined ? {} : { whenOccupied }),
                },
              ],
            },
            { groupPolicy: "open", allowFrom: ["discord:u-owner"] },
          ),
          client,
        );
        const entered = createDeferred<void>();
        const target = createDeferred<Awaited<ReturnType<typeof client.fetchChannel>>>();
        client.fetchChannel.mockImplementationOnce(() => {
          entered.resolve();
          return target.promise;
        });
        const readyEntered = createDeferred<void>();
        const ready = createDeferred<undefined>();
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        entersStateMock.mockImplementationOnce(() => {
          readyEntered.resolve();
          return ready.promise;
        });
        const captureNotes = vi.fn();
        const capturing = startTranscripts(manager, captureNotes, "queued-capture", "1002");
        await entered.promise;
        // The external join follows target resolution, after its owner continuation
        // enqueues autoJoin but before that queue's deferred reconciliation runs.
        const manual = target.promise.then(async () => {
          await Promise.resolve();
          return await manager.join({ guildId: "g1", channelId: "1003" });
        });
        target.resolve({
          id: "1002",
          type: ChannelType.GuildVoice,
          guildId: "g1",
          guild: { id: "g1", name: "Synthetic guild" },
        });
        let replacement: ReturnType<typeof startTranscripts> | undefined;
        try {
          await readyEntered.promise;
          if (transition === "stop") {
            expect(await stopTranscripts("queued-capture", "1002")).toMatchObject({ ok: true });
          } else if (transition === "replacement") {
            replacement = startTranscripts(manager, vi.fn(), "replacement", "1002");
          } else if (transition === "leave") {
            await manager.leave({ guildId: "g1", channelId: "1003" });
          }
          ready.resolve(undefined);
          if (transition === "leave") {
            expect(await manual).toMatchObject({ ok: false });
            expect(await capturing).toMatchObject({ ok: true });
            expect(manager.status()).toEqual([]);
            expect(connection.destroy).toHaveBeenCalledOnce();
            expect(joinVoiceChannelMock).toHaveBeenCalledOnce();
            return;
          }
          expect(await manual).toMatchObject({ ok: true });
          expect(connection.destroy).not.toHaveBeenCalled();
          const entry = getSessionEntry(manager);
          const snapshot = { ...entry };
          expect(await capturing).toMatchObject({ ok: transition === "none" });
          if (replacement) {
            expect(await replacement).toMatchObject({ ok: true });
          }
          expect(await discordVoiceTranscriptsSourceProvider.status!(source)).toMatchObject(
            transition === "stop"
              ? []
              : [
                  {
                    active: true,
                    sessionId: transition === "replacement" ? "replacement" : "queued-capture",
                  },
                ],
          );
          expect(getSessionEntry(manager)).toBe(entry);
          expect(entry).toMatchObject(snapshot);
          expect(connection.destroy).not.toHaveBeenCalled();
          expect(joinVoiceChannelMock).toHaveBeenCalledOnce();
          expect(manager.status()).toMatchObject([{ channelId: "1003" }]);
          const notes = vi.fn();
          expect(await startTranscripts(manager, notes, "manual-recorder", "1003")).toMatchObject({
            ok: true,
          });
          await receiveRecordedSpeech(manager, "newer manual conversation remains recordable");
          expect(notes).toHaveBeenCalledOnce();
          if (transition === "none" && whenOccupied !== true) {
            // Ordinary configured autoJoin retains its independent conversation policy.
            await manager.autoJoin();
            expect(manager.status()).toMatchObject([{ channelId: "1002" }]);
            expect(joinVoiceChannelMock).toHaveBeenCalledTimes(2);
            await receiveRecordedSpeech(manager, "configured conversation records its own source");
            expect(captureNotes).toHaveBeenCalledOnce();
            expect(notes).toHaveBeenCalledOnce();
          }
        } finally {
          ready.resolve(undefined);
          await Promise.all([capturing, manual, replacement]);
        }
      },
    );

    it.each([
      { residency: "live", invalid: "text" },
      { residency: "live", invalid: "denied" },
      { residency: "other autoJoin", invalid: "thread" },
      { residency: "other autoJoin", invalid: "lookup failure" },
      { residency: "empty autoJoin", invalid: "category" },
      { residency: "empty autoJoin", invalid: "wrong guild" },
      { residency: "unknown autoJoin", invalid: "text" },
      { residency: "unknown autoJoin", invalid: "wrong guild" },
    ] as const)(
      "rejects $invalid capture beside $residency without changing residency",
      async ({ residency, invalid }) => {
        const f = await fixture(residency);
        f.client.fetchChannel.mockImplementation(async (id) => {
          if (invalid === "denied") {
            throw new DiscordError(new Response(null, { status: 403 }), {
              message: "Missing Access",
              code: 50001,
            });
          }
          if (invalid === "lookup failure") {
            throw new TypeError("synthetic lookup failure");
          }
          const guildId = invalid === "wrong guild" ? "other-guild" : "g1";
          return {
            id,
            guildId,
            guild: { id: guildId, name: "Synthetic guild" },
            type:
              invalid === "text"
                ? ChannelType.GuildText
                : invalid === "thread"
                  ? ChannelType.PublicThread
                  : invalid === "category"
                    ? ChannelType.GuildCategory
                    : ChannelType.GuildVoice,
          };
        });
        // Operator authorization does not validate a Discord channel's recording capability.
        expect(
          await discordVoiceTranscriptsSourceProvider.accessControl!.authorize({
            action: "start",
            caller: { kind: "operator", source: "local" },
            source,
          }),
        ).toEqual({ ok: true, value: undefined });
        const result = await startTranscripts(f.manager, vi.fn(), "invalid-target", "1002");
        expect(result).toMatchObject({ ok: false });
        expect(await discordVoiceTranscriptsSourceProvider.status!(source)).toEqual([]);
        expect(await stopTranscripts("invalid-target", "1002")).toMatchObject({ ok: false });
        f.assertResidencyPreserved();
        if (residency === "live") {
          await receiveRecordedSpeech(f.manager, "the original recorder remains active");
          expect(f.preservedNotes).toHaveBeenCalledOnce();
        }
      },
    );

    it.each(
      (["live", "other autoJoin", "empty autoJoin", "unknown autoJoin"] as const).flatMap(
        (residency) =>
          [ChannelType.GuildVoice, ChannelType.GuildStageVoice].map((type) => ({
            residency,
            type,
          })),
      ),
    )(
      "registers valid channel type $type beside $residency without joining",
      async ({ residency, type }) => {
        const f = await fixture(residency);
        f.client.fetchChannel.mockImplementation(async (id) => ({
          id,
          type,
          guildId: "g1",
          guild: { id: "g1", name: "Synthetic guild" },
        }));
        expect(await startTranscripts(f.manager, vi.fn(), "valid-target", "1002")).toMatchObject({
          ok: true,
        });
        expect(await discordVoiceTranscriptsSourceProvider.status!(source)).toMatchObject([
          { active: true, sessionId: "valid-target", source },
        ]);
        f.assertResidencyPreserved();
      },
    );
    it("reuses an exact live target without another channel lookup or generation", async () => {
      const f = await fixture("live");
      f.client.fetchChannel.mockClear();
      f.client.fetchChannel.mockRejectedValue(new Error("REST unavailable after readiness"));
      const notes = vi.fn();
      expect(await startTranscripts(f.manager, notes, "same-target")).toMatchObject({ ok: true });
      expect(f.client.fetchChannel).not.toHaveBeenCalled();
      f.assertResidencyPreserved();
      await receiveRecordedSpeech(f.manager, "existing validated transport");
      expect(notes).toHaveBeenCalledOnce();
      expect(f.preservedNotes).not.toHaveBeenCalled();
    });

    it.each([
      { transition: "source stop", reject: false },
      { transition: "source stop", reject: true },
      { transition: "source replacement", reject: true },
      { transition: "manager replacement", reject: true },
      { transition: "destroy", reject: true },
      { transition: "leave", reject: false },
    ])(
      "fences pending validation across $transition (reject=$reject)",
      async ({ transition, reject }) => {
        const f = await fixture("live");
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const fetchChannel = f.client.fetchChannel.getMockImplementation()!;
        f.client.fetchChannel.mockImplementationOnce(async (id) => {
          entered.resolve();
          await release.promise;
          return fetchChannel(id);
        });
        const starting = startTranscripts(f.manager, vi.fn(), "pending-target", "1002");
        let replacement: ReturnType<typeof createManager> | undefined;
        try {
          await entered.promise;
          expect(await discordVoiceTranscriptsSourceProvider.status!(source)).toMatchObject([
            { active: false, sessionId: "pending-target" },
          ]);
          f.assertResidencyPreserved();
          if (transition === "source stop") {
            expect(await stopTranscripts("pending-target", "1002")).toMatchObject({ ok: true });
          } else if (transition === "source replacement") {
            expect(await startTranscripts(f.manager, vi.fn(), "replacement", "1002")).toMatchObject(
              {
                ok: true,
              },
            );
          } else if (transition === "manager replacement") {
            replacement = createManager(
              makeVoiceConfig({
                autoJoin: [{ guildId: "g1", channelId: "1003", whenOccupied: true }],
              }),
            );
            setDiscordTranscriptsVoiceManager({ accountId: "default", manager: replacement });
          } else if (transition === "destroy") {
            await f.manager.destroy();
          } else {
            expect(await f.manager.leave({ guildId: "g1" })).toMatchObject({ ok: true });
          }
          if (reject) {
            release.reject(new Error("stale lookup failure"));
          } else {
            release.resolve();
          }
          const result = await starting;
          expect(result).toMatchObject(
            transition === "leave"
              ? { ok: true }
              : { ok: false, error: expect.stringContaining("cancelled") },
          );
          expect(await discordVoiceTranscriptsSourceProvider.status!(source)).toMatchObject(
            transition === "source replacement"
              ? [{ active: true, sessionId: "replacement" }]
              : transition === "leave"
                ? [{ active: true, sessionId: "pending-target" }]
                : [],
          );
          expect(joinVoiceChannelMock).toHaveBeenCalledOnce();
          if (transition === "destroy" || transition === "leave") {
            expect(f.manager.status()).toEqual([]);
            expect(f.connection?.destroy).toHaveBeenCalledOnce();
          } else {
            f.assertResidencyPreserved();
            if (transition !== "manager replacement") {
              await receiveRecordedSpeech(f.manager, "unrelated capture survived");
              expect(f.preservedNotes).toHaveBeenCalledOnce();
            }
          }
        } finally {
          release.resolve();
          await starting;
          if (replacement) {
            await replacement.destroy();
            setDiscordTranscriptsVoiceManager({
              accountId: "default",
              manager: null,
              expectedManager: replacement,
            });
          }
        }
      },
    );

    it.each([
      { residency: "live", channelId: "1003" },
      { residency: "empty autoJoin", channelId: "1003" },
      { residency: "other autoJoin", channelId: "1002" },
    ] as const)(
      "keeps a newer $channelId join authoritative during $residency lookup",
      async ({ residency, channelId }) => {
        const f = await fixture(residency);
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const readyEntered = createDeferred<void>();
        const ready = createDeferred<undefined>();
        const fetchChannel = f.client.fetchChannel.getMockImplementation()!;
        f.client.fetchChannel.mockImplementationOnce(async (id) => {
          entered.resolve();
          await release.promise;
          return fetchChannel(id);
        });
        const starting = startTranscripts(f.manager, vi.fn(), "pending-target", "1002");
        await entered.promise;
        const connection = createConnectionMock();
        joinVoiceChannelMock.mockReturnValueOnce(connection);
        entersStateMock.mockImplementationOnce(() => {
          readyEntered.resolve();
          return ready.promise;
        });
        const manual = f.manager.join({ guildId: "g1", channelId });
        try {
          await readyEntered.promise;
          release.resolve();
          // The capture cannot commit while the newer transport is still being admitted.
          expect(await discordVoiceTranscriptsSourceProvider.status!(source)).toMatchObject([
            { active: false, sessionId: "pending-target" },
          ]);
          ready.resolve(undefined);
          expect(await manual).toMatchObject({ ok: true });
          const entry = getSessionEntry(f.manager);
          const snapshot = { ...entry };
          expect(await starting).toMatchObject({ ok: true });
          expect(getSessionEntry(f.manager)).toBe(entry);
          expect(entry).toMatchObject(snapshot);
          expect(connection.destroy).not.toHaveBeenCalled();
          expect(joinVoiceChannelMock).toHaveBeenCalledTimes(residency === "live" ? 2 : 1);
          expect(f.manager.status()).toMatchObject([{ channelId }]);
          expect(await discordVoiceTranscriptsSourceProvider.status!(source)).toMatchObject([
            { active: true, sessionId: "pending-target" },
          ]);
        } finally {
          release.resolve();
          ready.resolve(undefined);
          await Promise.all([starting, manual]);
        }
      },
    );

    it.each(["empty autoJoin", "unknown autoJoin"] as const)(
      "reconsiders $residency occupancy after target validation",
      async (residency) => {
        const f = await fixture(residency);
        const entered = createDeferred<void>();
        const release = createDeferred<void>();
        const fetchChannel = f.client.fetchChannel.getMockImplementation()!;
        f.client.fetchChannel.mockImplementationOnce(async (id) => {
          entered.resolve();
          await release.promise;
          return fetchChannel(id);
        });
        const notes = vi.fn();
        const starting = startTranscripts(f.manager, notes, "occupied-target", "1002");
        try {
          await entered.promise;
          f.states.push({
            guild_id: "g1",
            channel_id: "1002",
            user_id: "u-owner",
            member: { user: { id: "u-owner", bot: false } },
          });
          configureVoiceStateGateway(f.client, () => f.states);
          release.resolve();
          expect(await starting).toMatchObject({ ok: true });
          expect(f.manager.status()).toMatchObject([{ channelId: "1002" }]);
          expect(joinVoiceChannelMock).toHaveBeenCalledOnce();
          expect(createRealtimeVoiceBridgeSessionMock).toHaveBeenCalledOnce();
          await receiveRecordedSpeech(f.manager, "newly occupied target");
          expect(notes).toHaveBeenCalledOnce();
        } finally {
          release.resolve();
          await starting;
        }
      },
    );
  },
);
