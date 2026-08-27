import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  patchLiveQaGatewayConfig,
  readLiveQaGatewayConfig,
} from "../shared/live-gateway-config.runtime.js";
import {
  discordQaScenarioSupport,
  type DiscordQaScenarioImplementation,
  type DiscordQaScenarioRun,
} from "./discord-live.runtime.js";

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
  configureScenario: (implementation: DiscordQaScenarioImplementation) => Promise<{
    cfg: OpenClawConfig;
    configureTranscriptVoiceAccess?: (authorized: boolean) => Promise<void>;
    run: DiscordQaScenarioRun;
    voiceChannel?: Awaited<
      ReturnType<typeof discordQaScenarioSupport.testing.resolveDiscordQaVoiceChannel>
    >;
  }>;
  driverIdentity: DiscordIdentity;
  observedMessages: DiscordObservedMessage[];
  outputDir: string;
  runtimeEnv: DiscordRuntimeEnv;
  scenario: { id: string; timeoutMs: number; title: string };
  sutAccountId: string;
  sutIdentity: DiscordIdentity;
};

export function createDiscordQaScenarioEnvironment(params: {
  accountId: string;
  driverIdentity: DiscordIdentity;
  runtimeEnv: DiscordRuntimeEnv;
  sutIdentity: DiscordIdentity;
}) {
  const observedMessages: DiscordObservedMessage[] = [];
  const prepareFlow = async (input: FlowPreparationInput) => {
    return {
      discordScenarioContext: {
        configureScenario: async (implementation: DiscordQaScenarioImplementation) => {
          const run = implementation.buildRun(params.runtimeEnv.sutApplicationId);
          const voiceChannel =
            run.kind === "voice-autojoin" || run.kind === "transcripts-voice-authorization"
              ? await discordQaScenarioSupport.testing.resolveDiscordQaVoiceChannel({
                  guildId: params.runtimeEnv.guildId,
                  token: params.runtimeEnv.sutBotToken,
                  voiceChannelId: params.runtimeEnv.voiceChannelId,
                })
              : undefined;
          const applyConfig = async (transcriptVoiceAuthorized?: boolean) => {
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
                ...(run.kind === "voice-autojoin" && voiceChannel
                  ? {
                      voiceAutoJoin: {
                        channelId: voiceChannel.id,
                        guildId: params.runtimeEnv.guildId,
                      },
                    }
                  : {}),
                ...(run.kind === "transcripts-voice-authorization" && voiceChannel
                  ? {
                      voiceChannelAccess: {
                        channelId: voiceChannel.id,
                        users: [
                          transcriptVoiceAuthorized
                            ? params.driverIdentity.id
                            : params.sutIdentity.id,
                        ],
                      },
                    }
                  : {}),
                ...(run.kind === "progress-draft-lifecycle"
                  ? { progressDraftLabel: run.progressLabel }
                  : {}),
                statusReactionsToolOnly: run.kind === "status-reactions-tool-only",
              },
            );
            await patchLiveQaGatewayConfig({
              gateway: input.gateway,
              patch: cfg as Record<string, unknown>,
              replacePaths: [
                "channels.discord",
                "messages",
                "plugins",
                ...(run.kind === "transcripts-voice-authorization" && voiceChannel
                  ? [
                      `channels.discord.accounts.${params.accountId}.guilds.${params.runtimeEnv.guildId}.channels.${voiceChannel.id}.users`,
                    ]
                  : []),
              ],
              timeoutMs: input.timeoutMs,
              waitForConfigRestartSettle: input.waitForConfigRestartSettle,
            });
            await discordQaScenarioSupport.testing.waitForDiscordChannelRunning(
              input.gateway as never,
              params.accountId,
            );
            return cfg;
          };
          const cfg = await applyConfig(false);
          return {
            cfg,
            run,
            ...(run.kind === "transcripts-voice-authorization"
              ? {
                  configureTranscriptVoiceAccess: async (authorized: boolean) =>
                    void (await applyConfig(authorized)),
                }
              : {}),
            ...(voiceChannel ? { voiceChannel } : {}),
          };
        },
        driverIdentity: params.driverIdentity,
        observedMessages,
        outputDir: input.outputDir,
        runtimeEnv: params.runtimeEnv,
        scenario: {
          id: input.scenarioId,
          timeoutMs: input.timeoutMs,
          title: input.scenarioTitle,
        },
        sutAccountId: params.accountId,
        sutIdentity: params.sutIdentity,
      } satisfies DiscordQaScenarioEnvironment,
    };
  };
  return { prepareFlow };
}
