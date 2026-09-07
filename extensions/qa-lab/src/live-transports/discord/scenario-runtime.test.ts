import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discordQaScenarioSupport,
  type DiscordQaScenarioImplementation,
} from "./discord-live.runtime.js";
import type { DiscordQaScenarioEnvironment } from "./scenario-environment.js";
import { runDiscordScenario } from "./scenario-runtime.js";

describe("Discord QA scenario runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns structured RTT evidence for a matched reply", async () => {
    const implementation = {
      buildRun: () => ({
        kind: "channel-message",
        expectReply: true,
        input: "ping",
        expectedTextIncludes: ["pong"],
        matchText: "pong",
      }),
    } satisfies DiscordQaScenarioImplementation;
    const environment = {
      configureScenario: vi.fn(async () => ({ cfg: {}, run: implementation.buildRun() })),
      driverIdentity: { id: "423456789012345678", bot: true },
      observedMessages: [],
      outputDir: "/unused",
      runtimeEnv: {
        guildId: "123456789012345678",
        channelId: "223456789012345678",
        driverBotToken: "driver-token",
        sutBotToken: "sut-token",
        sutApplicationId: "323456789012345678",
      },
      scenario: { id: "discord-canary", timeoutMs: 30_000, title: "Discord canary" },
      sutAccountId: "sut",
      sutIdentity: { id: "323456789012345678", bot: true },
    } as unknown as DiscordQaScenarioEnvironment;
    const testing = discordQaScenarioSupport.testing;
    vi.spyOn(testing, "sendChannelMessage").mockResolvedValue({
      id: "523456789012345678",
      channel_id: environment.runtimeEnv.channelId,
      timestamp: "2026-09-02T12:00:00.000Z",
    });
    vi.spyOn(testing, "pollChannelMessages").mockResolvedValue({
      afterSnowflake: "623456789012345678",
      message: {
        messageId: "623456789012345678",
        channelId: environment.runtimeEnv.channelId,
        senderId: environment.sutIdentity.id,
        senderIsBot: true,
        text: "pong",
        timestamp: "2026-09-02T12:00:01.750Z",
      },
    });

    await expect(runDiscordScenario(environment, implementation)).resolves.toEqual({
      details: "reply matched",
      requestStartedAt: "2026-09-02T12:00:00.000Z",
      responseObservedAt: "2026-09-02T12:00:01.750Z",
      rttMs: 1750,
      rttMeasurement: {
        finalMatchedReplyRttMs: 1750,
        requestStartedAt: "2026-09-02T12:00:00.000Z",
        responseObservedAt: "2026-09-02T12:00:01.750Z",
        source: "request-to-observed-message",
      },
    });
  });
});
