import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  patchLiveQaGatewayConfig,
  readLiveQaGatewayConfig,
} from "../shared/live-gateway-config.runtime.js";
import { buildSlackQaConfig } from "./slack-live.config.js";
import type {
  SlackAuthIdentity,
  SlackObservedMessage,
  SlackQaScenarioImplementation,
  SlackQaScenarioContext,
  SlackQaScenarioMetadata,
  SlackQaScenarioRun,
  SlackQaWebClient as WebClient,
} from "./slack-live.contracts.js";
import { assertSlackCodexApprovalModelSupported } from "./slack-live.contracts.js";
import { waitForSlackChannelStable } from "./slack-live.message-observations.js";
import { sendSlackChannelMessage } from "./slack-live.observations.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;
type FlowPreparationInput = Parameters<NonNullable<AdapterDefinition["prepareFlow"]>>[0];

export type SlackQaScenarioEnvironment = {
  channelId: string;
  configureScenario: (implementation: SlackQaScenarioImplementation) => Promise<{
    cfg: OpenClawConfig;
    primaryModel: string;
    run: SlackQaScenarioRun;
  }>;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  gatewayDebugDirPath: string;
  getMessageWriteCursor: () => number;
  observedMessages: SlackObservedMessage[];
  readMessageWrites: (afterRequestEventId: number) => Promise<SlackObservedMessage[]>;
  outputDir: string;
  scenario: SlackQaScenarioMetadata;
  stopGateway: (preserveDebugArtifacts: boolean) => Promise<void>;
  sutAccountId: string;
  sutIdentity: SlackAuthIdentity;
  sutWriteClient: WebClient;
};

function resolveSlackQaReplacePaths(accountId: string, channelId: string): string[] {
  return [
    "agents",
    "approvals",
    "channels.slack",
    `channels.slack.accounts.${accountId}.allowFrom`,
    `channels.slack.accounts.${accountId}.channels.${channelId}.users`,
    "messages",
    "plugins",
    "tools",
  ];
}

export function createSlackQaScenarioEnvironment(params: {
  accountId: string;
  channelId: string;
  driverBotUserId: string;
  driverClient: WebClient;
  getMessageWriteCursor: () => number;
  readMessageWrites: (afterRequestEventId: number) => Promise<SlackObservedMessage[]>;
  sutAppToken: string;
  sutBotToken: string;
  sutIdentity: SlackAuthIdentity;
  sutReadClient: WebClient;
  sutWriteClient: WebClient;
}) {
  const observedMessages: SlackObservedMessage[] = [];

  const prepareFlow = async (
    input: FlowPreparationInput,
  ): Promise<{ slackScenarioContext: SlackQaScenarioEnvironment }> => {
    const context = {
      channelId: params.channelId,
      driverClient: params.driverClient,
      gateway: input.gateway as never,
      postSlackMessage: async (message: { text: string; threadTs?: string }) =>
        await sendSlackChannelMessage({
          channelId: params.channelId,
          client: params.driverClient,
          text: message.text,
          threadTs: message.threadTs,
        }),
      sutIdentity: params.sutIdentity,
      sutReadClient: params.sutReadClient,
      waitForReady: async () =>
        await waitForSlackChannelStable(input.gateway as never, params.accountId, "connected"),
    } satisfies Omit<SlackQaScenarioContext, "sentTs">;
    return {
      slackScenarioContext: {
        channelId: params.channelId,
        configureScenario: async (implementation: SlackQaScenarioImplementation) => {
          if (!input.primaryModel) {
            throw new Error("Slack QA module flow requires a primary model");
          }
          const primaryModel = input.primaryModel;
          const run = implementation.buildRun(params.sutIdentity.userId);
          if (run.kind === "codex-approval") {
            assertSlackCodexApprovalModelSupported(primaryModel);
          }
          const snapshot = await readLiveQaGatewayConfig(input.gateway);
          const cfg = buildSlackQaConfig(snapshot.config as OpenClawConfig, {
            channelId: params.channelId,
            driverBotUserId: params.driverBotUserId,
            overrides: implementation.configOverrides,
            primaryModel,
            sutAccountId: params.accountId,
            sutAppToken: params.sutAppToken,
            sutBotToken: params.sutBotToken,
          });
          await patchLiveQaGatewayConfig({
            gateway: input.gateway,
            patch: cfg as Record<string, unknown>,
            replacePaths: resolveSlackQaReplacePaths(params.accountId, params.channelId),
            timeoutMs: input.timeoutMs,
            waitForConfigRestartSettle: input.waitForConfigRestartSettle,
          });
          const readinessMode =
            run.kind === "approval" || run.kind === "codex-approval" ? "started" : "connected";
          await waitForSlackChannelStable(input.gateway as never, params.accountId, readinessMode);
          return { cfg, primaryModel, run };
        },
        context,
        gatewayDebugDirPath: path.join(input.outputDir, "gateway-debug"),
        getMessageWriteCursor: params.getMessageWriteCursor,
        observedMessages,
        readMessageWrites: params.readMessageWrites,
        outputDir: input.outputDir,
        scenario: {
          id: input.scenarioId,
          timeoutMs: input.timeoutMs,
          title: input.scenarioTitle,
        },
        stopGateway: async (preserveDebugArtifacts: boolean) => {
          if (!input.gateway.stop) {
            throw new Error("Slack QA scenario requires gateway stop support");
          }
          await input.gateway.stop(
            preserveDebugArtifacts
              ? { preserveToDir: path.join(input.outputDir, "gateway-debug") }
              : undefined,
          );
        },
        sutAccountId: params.accountId,
        sutIdentity: params.sutIdentity,
        sutWriteClient: params.sutWriteClient,
      } satisfies SlackQaScenarioEnvironment,
    };
  };

  return { prepareFlow };
}
