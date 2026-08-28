import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
const { requestDiscordMock } = vi.hoisted(() => ({ requestDiscordMock: vi.fn() }));

vi.mock("@openclaw/discord/api.js", () => ({ requestDiscord: requestDiscordMock }));

import { discordQaScenarioSupport } from "./discord-live.runtime.js";
import {
  discordQaTranscriptsVoiceAuthorizationScenario,
  runDiscordTranscriptsVoiceAuthorizationScenario,
} from "./discord-transcripts-authorization.runtime.js";
import type { DiscordQaScenarioEnvironment } from "./scenario-environment.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Discord transcript authorization live scenario", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("proves visible denial, authorized join/stop, and message cleanup", async () => {
    const outputDir = tempDirs.make("discord-transcript-auth-");
    const run = discordQaTranscriptsVoiceAuthorizationScenario.buildRun("323456789012345678");
    if (run.kind !== "transcripts-voice-authorization") {
      throw new Error("unexpected scenario run kind");
    }
    const configureTranscriptVoiceAccess = vi.fn(async () => {});
    const environment = {
      configureScenario: vi.fn(),
      driverIdentity: { id: "423456789012345678", bot: true },
      observedMessages: [],
      outputDir,
      runtimeEnv: {
        guildId: "123456789012345678",
        channelId: "223456789012345678",
        voiceChannelId: "523456789012345678",
        driverBotToken: "driver-token",
        sutBotToken: "sut-token",
        sutApplicationId: "323456789012345678",
      },
      scenario: {
        id: "discord-transcripts-voice-authorization",
        timeoutMs: 60_000,
        title: "Discord transcript capture enforces voice authorization",
      },
      sutAccountId: "sut",
      sutIdentity: { id: "323456789012345678", bot: true },
    } as unknown as DiscordQaScenarioEnvironment;
    const testing = discordQaScenarioSupport.testing;
    const send = vi
      .spyOn(testing, "sendChannelMessage")
      .mockResolvedValueOnce({
        id: "623456789012345671",
        channel_id: environment.runtimeEnv.channelId,
        timestamp: "2026-08-14T12:00:00.000Z",
      })
      .mockResolvedValueOnce({
        id: "623456789012345673",
        channel_id: environment.runtimeEnv.channelId,
        timestamp: "2026-08-14T12:00:01.000Z",
      })
      .mockResolvedValueOnce({
        id: "623456789012345675",
        channel_id: environment.runtimeEnv.channelId,
        timestamp: "2026-08-14T12:00:02.000Z",
      });
    vi.spyOn(testing, "pollChannelMessages")
      .mockResolvedValueOnce({
        afterSnowflake: "623456789012345672",
        message: {
          messageId: "623456789012345672",
          channelId: environment.runtimeEnv.channelId,
          senderId: environment.sutIdentity.id,
          senderIsBot: true,
          text: `${run.negativeMarker} You are not authorized to use this command.`,
        },
      })
      .mockResolvedValueOnce({
        afterSnowflake: "623456789012345674",
        message: {
          messageId: "623456789012345674",
          channelId: environment.runtimeEnv.channelId,
          senderId: environment.sutIdentity.id,
          senderIsBot: true,
          text: run.positiveMarker,
        },
      })
      .mockResolvedValueOnce({
        afterSnowflake: "623456789012345676",
        message: {
          messageId: "623456789012345676",
          channelId: environment.runtimeEnv.channelId,
          senderId: environment.sutIdentity.id,
          senderIsBot: true,
          text: run.stopMarker,
        },
      });
    vi.spyOn(testing, "getCurrentDiscordVoiceState").mockResolvedValue(null);
    vi.spyOn(testing, "waitForDiscordVoiceState").mockResolvedValue({
      channel_id: "523456789012345678",
      guild_id: "123456789012345678",
      user_id: environment.sutIdentity.id,
    });
    requestDiscordMock.mockResolvedValue(undefined);

    await expect(
      runDiscordTranscriptsVoiceAuthorizationScenario(environment, {
        cfg: {},
        configureTranscriptVoiceAccess,
        run,
        voiceChannel: { id: "523456789012345678", type: 2 },
      }),
    ).resolves.toMatchObject({
      details: "visible denial, authorized transcript join, and verified stop/leave",
    });

    expect(configureTranscriptVoiceAccess).toHaveBeenCalledExactlyOnceWith(true);
    expect(send).toHaveBeenCalledTimes(3);
    const prompts = send.mock.calls.map((call) => call[2]);
    expect(prompts[0]).toContain('"action":"start"');
    expect(prompts[0]).toContain(run.deniedSessionId);
    expect(prompts[1]).toContain(run.allowedSessionId);
    expect(prompts[2]).toContain('"action":"stop"');
    expect(prompts.join("\n")).not.toContain('"accountId"');
    expect(requestDiscordMock).toHaveBeenCalledTimes(6);

    const evidence = JSON.parse(
      await fs.readFile(
        path.join(outputDir, "discord-transcripts-voice-authorization-evidence.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(evidence).toEqual({
      schemaVersion: 1,
      scenarioId: "discord-transcripts-voice-authorization",
      denied: {
        replyObserved: true,
        visibleDenial: true,
        voiceStayedDisconnected: true,
      },
      allowed: { replyObserved: true, voiceJoined: true },
      cleanup: {
        emergencyStopAttempted: false,
        messagesDeleted: 6,
        messageDeleteFailures: 0,
        stopReplyObserved: true,
        voiceDisconnected: true,
      },
    });
  });
});
