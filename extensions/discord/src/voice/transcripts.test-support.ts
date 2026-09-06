import type { TranscriptStartRequest } from "openclaw/plugin-sdk/transcripts";
import { afterEach, vi } from "vitest";
import {
  discordVoiceTranscriptsSourceProvider,
  setDiscordTranscriptsVoiceManager,
} from "./transcripts-source.js";
import type { DiscordVoiceManager } from "./voice-runtime.js";

export function createDiscordVoiceTranscriptFixture() {
  const captures: Array<{
    sessionId: string;
    source: { providerId: string; accountId: string; guildId: string; channelId: string };
  }> = [];
  const captureManagers = new Set<DiscordVoiceManager>();
  const registeredManagers = new Map<string, DiscordVoiceManager>();
  const startTranscripts = async (
    manager: DiscordVoiceManager,
    onUtterance: TranscriptStartRequest["onUtterance"] = vi.fn(),
    sessionId = "notes-1",
    channelId = "1001",
    accountId = "default",
  ) => {
    setDiscordTranscriptsVoiceManager({ accountId, manager });
    registeredManagers.set(accountId, manager);
    captureManagers.add(manager);
    const source = { providerId: "discord-voice", accountId, guildId: "g1", channelId };
    captures.push({ sessionId, source });
    return await discordVoiceTranscriptsSourceProvider.start!({
      session: { sessionId, source, startedAt: new Date().toISOString() },
      onUtterance,
    });
  };
  const stopTranscripts = async (
    sessionId = "notes-1",
    channelId = "1001",
    accountId = "default",
  ) =>
    await discordVoiceTranscriptsSourceProvider.stop!({
      sessionId,
      source: { providerId: "discord-voice", accountId, guildId: "g1", channelId },
    });
  afterEach(async () => {
    for (const capture of captures.splice(0)) {
      await discordVoiceTranscriptsSourceProvider.stop!(capture);
    }
    for (const [accountId, manager] of registeredManagers) {
      setDiscordTranscriptsVoiceManager({ accountId, manager: null, expectedManager: manager });
    }
    registeredManagers.clear();
    for (const manager of captureManagers) {
      await manager.destroy();
    }
    captureManagers.clear();
  });
  return { startTranscripts, stopTranscripts };
}
