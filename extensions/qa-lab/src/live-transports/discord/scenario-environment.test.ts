import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discordQaScenarioSupport,
  discordQaVoiceAutojoinScenario,
} from "./discord-live.runtime.js";
import { discordQaTranscriptsVoiceAuthorizationScenario } from "./discord-transcripts-authorization.runtime.js";
import { createDiscordQaScenarioEnvironment } from "./scenario-environment.js";

const guildId = "123456789012345678";
const textChannelId = "223456789012345678";
const sutId = "323456789012345678";
const driverId = "423456789012345678";
const voiceChannelId = "523456789012345678";

async function prepareScenario(voiceDestination?: string) {
  const patches: OpenClawConfig[] = [];
  const call = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return {
        config: {},
        hash: "config-hash",
        appliedConfigHash: "runtime-hash",
        configRevisionHash: "runtime-hash",
      };
    }
    if (method === "config.patch") {
      patches.push(JSON.parse((params as { raw: string }).raw) as OpenClawConfig);
      return { hash: "config-hash" };
    }
    if (method === "channels.status") {
      return {
        channelAccounts: { discord: [{ accountId: "sut", running: true, connected: true }] },
      };
    }
    throw new Error(`unexpected gateway call: ${method}`);
  });
  const environment = createDiscordQaScenarioEnvironment({
    accountId: "sut",
    driverIdentity: { id: driverId, bot: true },
    sutIdentity: { id: sutId, bot: true },
    runtimeEnv: {
      guildId,
      channelId: textChannelId,
      driverBotToken: "driver-token",
      sutBotToken: "sut-token",
      sutApplicationId: sutId,
      ...(voiceDestination ? { voiceChannelId: voiceDestination } : {}),
    },
  });
  const prepared = await environment.prepareFlow({
    config: {},
    gateway: {
      baseUrl: "http://127.0.0.1:1",
      tempRoot: "/unused",
      workspaceDir: "/unused",
      runtimeEnv: {},
      call,
    },
    outputDir: "/unused",
    scenarioId: "discord-voice-test",
    scenarioTitle: "Discord voice setup",
    timeoutMs: 60_000,
    waitForConfigRestartSettle: vi.fn(async () => {}),
  });
  return { call, patches, configureScenario: prepared.discordScenarioContext.configureScenario };
}

describe("Discord QA scenario environment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects transcript capture without an explicit destination before discovery or gateway access", async () => {
    const resolveVoiceChannel = vi
      .spyOn(discordQaScenarioSupport.testing, "resolveDiscordQaVoiceChannel")
      .mockRejectedValue(new Error("must not discover a voice destination"));
    const { call, configureScenario } = await prepareScenario();

    await expect(configureScenario(discordQaTranscriptsVoiceAuthorizationScenario)).rejects.toThrow(
      "requires an explicit QA voiceChannelId",
    );
    expect(resolveVoiceChannel).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "transcript authorization",
      explicit: true,
      implementation: discordQaTranscriptsVoiceAuthorizationScenario,
    },
    { name: "autojoin discovery", explicit: false, implementation: discordQaVoiceAutojoinScenario },
  ])("configures the selected voice channel for $name", async ({ explicit, implementation }) => {
    const voiceChannel = { id: voiceChannelId, guild_id: guildId, type: 2 };
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify(explicit ? voiceChannel : [{ id: textChannelId, type: 0 }, voiceChannel]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", request);
    const { configureScenario, patches } = await prepareScenario(
      explicit ? voiceChannelId : undefined,
    );

    const configured = await configureScenario(implementation);

    expect(configured.voiceChannel).toEqual(voiceChannel);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe(
      `https://discord.com/api/v10/${explicit ? `channels/${voiceChannelId}` : `guilds/${guildId}/channels`}`,
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]?.channels?.discord?.voice?.autoJoin).toEqual(
      explicit ? [] : [{ guildId, channelId: voiceChannelId }],
    );
    if (explicit) {
      expect(
        patches[0]?.channels?.discord?.accounts?.sut?.guilds?.[guildId]?.channels?.[voiceChannelId]
          ?.users,
      ).toEqual([sutId]);
      await configured.configureTranscriptVoiceAccess?.(true);
      expect(patches).toHaveLength(2);
      expect(
        patches[1]?.channels?.discord?.accounts?.sut?.guilds?.[guildId]?.channels?.[voiceChannelId]
          ?.users,
      ).toEqual([driverId]);
      expect(
        patches[1]?.channels?.discord?.accounts?.sut?.guilds?.[guildId]?.channels?.[textChannelId]
          ?.users,
      ).toEqual([driverId]);
      expect(request).toHaveBeenCalledOnce();
    }
  });
});
