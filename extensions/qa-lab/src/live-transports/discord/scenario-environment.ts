import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  patchLiveQaGatewayConfig,
  readLiveQaGatewayConfig,
} from "../shared/live-gateway-config.runtime.js";
import { discordQaScenarioSupport } from "./discord-live.runtime.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;
type FlowPreparationInput = Parameters<NonNullable<AdapterDefinition["prepareFlow"]>>[0];
type DiscordRuntimeEnv = ReturnType<
  typeof discordQaScenarioSupport.testing.resolveDiscordQaRuntimeEnv
>;
type DiscordIdentity = Awaited<
  ReturnType<typeof discordQaScenarioSupport.testing.getCurrentDiscordUser>
>;
type DiscordObservedMessage = Parameters<
  typeof discordQaScenarioSupport.testing.pollChannelMessages
>[0]["observedMessages"][number];

export type DiscordQaScenarioEnvironment = {
  cfg: OpenClawConfig;
  driverIdentity: DiscordIdentity;
  observedMessages: DiscordObservedMessage[];
  outputDir: string;
  runtimeEnv: DiscordRuntimeEnv;
  sutAccountId: string;
  sutIdentity: DiscordIdentity;
  voiceChannel?: Awaited<
    ReturnType<typeof discordQaScenarioSupport.testing.resolveDiscordQaVoiceChannel>
  >;
};

export function createDiscordQaScenarioEnvironment(params: {
  accountId: string;
  driverIdentity: DiscordIdentity;
  runtimeEnv: DiscordRuntimeEnv;
  sutIdentity: DiscordIdentity;
}) {
  const observedMessages: DiscordObservedMessage[] = [];
  const prepareFlow = async (input: FlowPreparationInput) => {
    const scenarioId = input.config.discordScenarioId;
    if (typeof scenarioId !== "string") {
      throw new Error("Discord QA module flow requires config.discordScenarioId");
    }
    const scenario = discordQaScenarioSupport.testing.findScenario([scenarioId])[0];
    if (!scenario) {
      throw new Error(`unknown Discord QA scenario id: ${scenarioId}`);
    }
    const scenarioRun = scenario.buildRun(params.runtimeEnv.sutApplicationId);
    const voiceChannel =
      scenarioRun.kind === "voice-autojoin"
        ? await discordQaScenarioSupport.testing.resolveDiscordQaVoiceChannel({
            guildId: params.runtimeEnv.guildId,
            token: params.runtimeEnv.sutBotToken,
            voiceChannelId: params.runtimeEnv.voiceChannelId,
          })
        : undefined;
    const snapshot = await readLiveQaGatewayConfig(input.gateway);
    const cfg = discordQaScenarioSupport.testing.buildDiscordQaConfig(
      snapshot.config as OpenClawConfig,
      {
        guildId: params.runtimeEnv.guildId,
        channelId: params.runtimeEnv.channelId,
        driverBotId: params.driverIdentity.id,
        sutAccountId: params.accountId,
        sutBotToken: params.runtimeEnv.sutBotToken,
      },
      {
        ...(voiceChannel
          ? { voiceAutoJoin: { channelId: voiceChannel.id, guildId: params.runtimeEnv.guildId } }
          : {}),
        statusReactionsToolOnly: scenarioRun.kind === "status-reactions-tool-only",
      },
    );
    await patchLiveQaGatewayConfig({
      gateway: input.gateway,
      patch: cfg as Record<string, unknown>,
      replacePaths: ["channels.discord", "messages", "plugins"],
      timeoutMs: input.timeoutMs,
      waitForConfigRestartSettle: input.waitForConfigRestartSettle,
    });
    await discordQaScenarioSupport.testing.waitForDiscordChannelRunning(
      input.gateway as never,
      params.accountId,
    );
    return {
      discordScenarioContext: {
        cfg,
        driverIdentity: params.driverIdentity,
        observedMessages,
        outputDir: input.outputDir,
        runtimeEnv: params.runtimeEnv,
        sutAccountId: params.accountId,
        sutIdentity: params.sutIdentity,
        ...(voiceChannel ? { voiceChannel } : {}),
      } satisfies DiscordQaScenarioEnvironment,
    };
  };
  return { prepareFlow };
}
