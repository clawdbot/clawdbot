import path from "node:path";
import {
  discordVoiceTranscriptsSourceProvider,
  loadDiscordVoiceTestHarness,
  setDiscordTranscriptsVoiceManager,
} from "../extensions/discord/test-api.js";
import { activeSessions } from "../src/agents/tools/transcripts-tool-runtime.js";
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
  }) => {
    it("retires a replaced transcript capture in core without stopping its Discord replacement", async () => {
      const tempDirs = createTempDirTracker();
      const stateDir = tempDirs.make("discord-transcripts-replacement-");
      const accountId = "transcript-replacement";
      const discordConfig = makeVoiceConfig(
        {},
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
        expect(first.source).toMatchObject(source);
        expect(second.source).toEqual(first.source);
        expect(
          (await store.readUtterancesForSession(first)).map((utterance) => utterance.text),
        ).toEqual(["Keep the original historical note."]);
        expect(
          (await store.readUtterancesForSession(second)).map((utterance) => utterance.text),
        ).toEqual(["This belongs only to the replacement."]);
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

        await expect(execute({ action: "summarize", sessionId: "first" })).resolves.toMatchObject({
          details: { summary: { sessionId: "first", utteranceCount: 1 } },
        });
        await execute({ action: "stop", sessionId: "first" });
        expect.soft(providerStop).not.toHaveBeenCalled();
        expectConnectedStatus(manager, "1001");
        await expect(execute({ action: "status" })).resolves.toMatchObject({
          details: { active: [expect.objectContaining({ sessionId: "second" })] },
        });
        await manager.destroy();
        await vi.waitFor(async () => {
          await expect(execute({ action: "status" })).resolves.toMatchObject({
            details: { active: [], pendingFinalization: [] },
          });
          expect(await store.readSession("second")).toMatchObject({
            stoppedAt: expect.any(String),
          });
        });
      } finally {
        try {
          await manager.destroy();
        } finally {
          setDiscordTranscriptsVoiceManager({ accountId, manager: null });
          activeSessions.delete("first");
          activeSessions.delete("second");
          providerStop.mockRestore();
          closeOpenClawStateDatabaseForTest();
          tempDirs.cleanup();
        }
      }
    });
  },
);
