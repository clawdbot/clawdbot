import path from "node:path";
import {
  discordVoiceTranscriptsSourceProvider,
  loadDiscordVoiceTestHarness,
  setDiscordTranscriptsVoiceManager,
} from "../extensions/discord/test-api.js";
import { createTranscriptsTool } from "../src/agents/tools/transcripts-tool.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../src/plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../src/state/openclaw-state-db.js";
import { TranscriptsStore } from "../src/transcripts/store.js";
import { createTempDirTracker } from "./helpers/temp-dir.js";

const { defineDiscordVoiceTests } = await loadDiscordVoiceTestHarness();

defineDiscordVoiceTests(
  ({
    expect,
    expectDefined,
    it,
    vi,
    createClientWithMember,
    createManager,
    makeVoiceConfig,
    getSessionEntry,
    getVoiceReceive,
    expectConnectedStatus,
    requireRecord,
    transcribeAudioFileMock,
    lastRealtimeBridgeParams,
    beginSpeakerTurn,
  }) => {
    it.each(["manager destruction", "completed", "error"] as const)(
      "retires replaced captures and handles %s without stopping a Discord replacement",
      async (terminal) => {
        const tempDirs = createTempDirTracker();
        const stateDir = tempDirs.make("discord-transcripts-replacement-");
        const accountId = "transcript-replacement";
        const discordConfig = makeVoiceConfig(
          { mode: terminal === "manager destruction" ? "stt-tts" : "agent-proxy" },
          { token: "test-token", groupPolicy: "open", allowFrom: ["discord:u-speaker"] },
        );
        const config = {
          transcripts: { enabled: true },
          channels: { discord: { accounts: { [accountId]: discordConfig } } },
        };
        const manager = createManager(
          discordConfig,
          createClientWithMember("u-speaker", "Speaker", "0001"),
          config,
          accountId,
        );
        const registry = createEmptyPluginRegistry();
        registry.transcriptSourceProviders.push({
          pluginId: "discord",
          source: "discord/transcripts-source-api.ts",
          provider: discordVoiceTranscriptsSourceProvider,
        });
        const tool = createTranscriptsTool({
          config,
          stateDir,
          agentId: "transcript-replacement",
          caller: { kind: "operator", source: "local" },
        });
        const execute = (params: Record<string, unknown>) =>
          withPluginRuntimeRegistryScope(registry, () => tool.execute("transcripts", params));
        const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        });
        const source = { providerId: "discord-voice", accountId, guildId: "g1", channelId: "1001" };
        const providerStop = vi.spyOn(discordVoiceTranscriptsSourceProvider, "stop");
        setDiscordTranscriptsVoiceManager({ accountId, manager });

        try {
          await expect(
            execute({ action: "start", sessionId: "first", ...source }),
          ).resolves.toMatchObject({
            details: { sessionId: "first", providerId: "discord-voice", accountId },
          });
          const entry = getSessionEntry(manager);
          const segment = {
            entry,
            wavPath: path.join(stateDir, "speech.wav"),
            userId: "u-speaker",
            durationSeconds: 1,
          };
          transcribeAudioFileMock.mockResolvedValueOnce({
            text: "Keep the original historical note.",
          });
          await getVoiceReceive(manager).processSegment(segment);

          await expect(
            execute({ action: "start", sessionId: "second", ...source }),
          ).resolves.toMatchObject({
            details: { sessionId: "second", providerId: "discord-voice", accountId },
          });
          transcribeAudioFileMock.mockResolvedValueOnce({
            text: "This belongs only to the replacement.",
          });
          await getVoiceReceive(manager).processSegment({
            ...segment,
            entry: getSessionEntry(manager),
          });

          const first = expectDefined(await store.readSession("first"), "first capture");
          const second = expectDefined(await store.readSession("second"), "second capture");
          const secondTexts = ["This belongs only to the replacement."];
          expect(first.source).toMatchObject(source);
          expect(second.source).toEqual(first.source);
          expect(
            (await store.readUtterancesForSession(first)).map((utterance) => utterance.text),
          ).toEqual(["Keep the original historical note."]);
          expect(
            (await store.readUtterancesForSession(second)).map((utterance) => utterance.text),
          ).toEqual(secondTexts);
          expectConnectedStatus(manager, "1001");
          expect(providerStop).not.toHaveBeenCalled();

          const status = await execute({ action: "status" });
          const active = requireRecord(status.details, "transcript status").active;
          expect(Array.isArray(active)).toBe(true);
          if (!Array.isArray(active)) {
            throw new Error("expected transcript status active sessions");
          }
          // Keep the stale-status failure first, then exercise historical recovery as well.
          expect
            .soft(active.map((capture) => requireRecord(capture, "active capture").sessionId))
            .toEqual(["second"]);
          expect.soft(first.stoppedAt).toEqual(expect.any(String));

          await expect(execute({ action: "summarize", sessionId: "first" })).resolves.toMatchObject(
            {
              details: { summary: { sessionId: "first", utteranceCount: 1 } },
            },
          );
          await execute({ action: "stop", sessionId: "first" });
          expect.soft(providerStop).not.toHaveBeenCalled();
          expectConnectedStatus(manager, "1001");
          await expect(execute({ action: "status" })).resolves.toMatchObject({
            details: { active: [expect.objectContaining({ sessionId: "second" })] },
          });
          if (terminal !== "manager destruction") {
            await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toMatchObject(
              {
                ok: true,
              },
            );
          }
          const provider =
            terminal === "manager destruction" ? undefined : lastRealtimeBridgeParams();
          const speaker = { userId: "u-speaker", speakerLabel: "Speaker", senderIsOwner: false };
          const turn = provider ? beginSpeakerTurn(getSessionEntry(manager), speaker) : undefined;
          if (provider) {
            expectDefined(
              provider.onClose,
              "provider terminal callback",
            )(terminal === "error" ? "error" : "completed");
            expectConnectedStatus(manager, "1001");
            await expect(execute({ action: "status" })).resolves.toMatchObject({
              details: {
                active: [expect.objectContaining({ sessionId: "second" })],
                pendingFinalization: [],
              },
            });
            const ongoing = expectDefined(await store.readSession("second"), "ongoing capture");
            expect(ongoing.stoppedAt).toBeUndefined();

            beginSpeakerTurn(getSessionEntry(manager), speaker);
            const recovered = expectDefined(lastRealtimeBridgeParams(), "recovered speaker");
            expect(recovered).not.toBe(provider);
            provider.onTranscript?.("user", "Late text from the retired speaker.", true);
            const recoveredText = "The same capture continues after reconnect.";
            secondTexts.push(recoveredText);
            recovered.onTranscript?.("user", recoveredText, true);
            await vi.waitFor(async () => {
              expect(
                (await store.readUtterancesForSession(second)).map((utterance) => utterance.text),
              ).toEqual(secondTexts);
            });
            expect(providerStop).not.toHaveBeenCalled();
            await expect(manager.leave({ guildId: "g1" })).resolves.toMatchObject({ ok: true });
          } else {
            await manager.destroy();
          }
          await vi.waitFor(async () => {
            await expect(execute({ action: "status" })).resolves.toMatchObject({
              details: { active: [], pendingFinalization: [] },
            });
            expect(await store.readSession("second")).toMatchObject({
              stoppedAt: expect.any(String),
            });
          });
          expect(manager.status()).toEqual([]);
          expect(providerStop).not.toHaveBeenCalled();

          if (provider) {
            const stoppedSecond = expectDefined(await store.readSession("second"), "ended capture");
            await expect(
              execute({ action: "start", sessionId: "third", ...source }),
            ).resolves.toMatchObject({
              details: { sessionId: "third", providerId: "discord-voice", accountId },
            });
            await expect(manager.join({ guildId: "g1", channelId: "1001" })).resolves.toMatchObject(
              { ok: true },
            );
            turn?.close();
            provider.onClose?.("error");
            provider.onReady?.();
            provider.onTranscript?.("user", "Late text from the retired provider.", true);
            await execute({ action: "stop", sessionId: "second" });
            expect(providerStop).not.toHaveBeenCalled();
            expectConnectedStatus(manager, "1001");
            await expect(execute({ action: "status" })).resolves.toMatchObject({
              details: {
                active: [expect.objectContaining({ sessionId: "third" })],
                pendingFinalization: [],
              },
            });
            expect(await store.readSession("second")).toMatchObject({
              stoppedAt: stoppedSecond.stoppedAt,
            });
            expect(
              (await store.readUtterancesForSession(stoppedSecond)).map(
                (utterance) => utterance.text,
              ),
            ).toEqual(secondTexts);
            const third = expectDefined(await store.readSession("third"), "replacement capture");
            expect(await store.readUtterancesForSession(third)).toEqual([]);
          }
        } finally {
          try {
            await manager.destroy();
            await vi.waitFor(async () => {
              await expect(execute({ action: "status" })).resolves.toMatchObject({
                details: { active: [], pendingFinalization: [] },
              });
            });
          } finally {
            setDiscordTranscriptsVoiceManager({ accountId, manager: null });
            providerStop.mockRestore();
            closeOpenClawStateDatabaseForTest();
            tempDirs.cleanup();
          }
        }
      },
    );
  },
);
