import path from "node:path";
import type { WebClient } from "@slack/web-api";
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
  SlackQaScenarioContext,
} from "./slack-live.contracts.js";
import { assertSlackCodexApprovalModelSupported } from "./slack-live.contracts.js";
import { waitForSlackChannelStable } from "./slack-live.message-observations.js";
import { sendSlackChannelMessage } from "./slack-live.observations.js";
import { getSlackQaScenarioDefinition } from "./slack-live.scenarios.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;
type FlowPreparationInput = Parameters<NonNullable<AdapterDefinition["prepareFlow"]>>[0];

export type SlackQaScenarioEnvironment = {
  cfg: OpenClawConfig;
  channelId: string;
  context: Omit<SlackQaScenarioContext, "sentTs">;
  gatewayDebugDirPath: string;
  observedMessages: SlackObservedMessage[];
  outputDir: string;
  primaryModel: string;
  stopGateway: (preserveDebugArtifacts: boolean) => Promise<void>;
  sutAccountId: string;
  sutIdentity: SlackAuthIdentity;
  sutWriteClient: WebClient;
};

export function createSlackQaScenarioEnvironment(params: {
  accountId: string;
  channelId: string;
  driverBotUserId: string;
  driverClient: WebClient;
  sutAppToken: string;
  sutBotToken: string;
  sutIdentity: SlackAuthIdentity;
  sutReadClient: WebClient;
  sutWriteClient: WebClient;
}) {
  const observedMessages: SlackObservedMessage[] = [];

  const prepareFlow = async (input: FlowPreparationInput) => {
    const scenarioId = input.config.slackScenarioId;
    if (typeof scenarioId !== "string") {
      throw new Error("Slack QA module flow requires config.slackScenarioId");
    }
    if (!input.primaryModel) {
      throw new Error("Slack QA module flow requires a primary model");
    }
    const primaryModel = input.primaryModel;
    const scenario = getSlackQaScenarioDefinition(scenarioId);
    const scenarioRun = scenario.buildRun(params.sutIdentity.userId);
    if (scenarioRun.kind === "codex-approval") {
      assertSlackCodexApprovalModelSupported(primaryModel);
    }
    const snapshot = await readLiveQaGatewayConfig(input.gateway);
    const cfg = buildSlackQaConfig(snapshot.config as OpenClawConfig, {
      channelId: params.channelId,
      driverBotUserId: params.driverBotUserId,
      overrides: scenario.configOverrides,
      primaryModel,
      sutAccountId: params.accountId,
      sutAppToken: params.sutAppToken,
      sutBotToken: params.sutBotToken,
    });
    await patchLiveQaGatewayConfig({
      gateway: input.gateway,
      patch: cfg as Record<string, unknown>,
      replacePaths: ["agents", "approvals", "channels.slack", "messages", "plugins", "tools"],
      timeoutMs: input.timeoutMs,
      waitForConfigRestartSettle: input.waitForConfigRestartSettle,
    });
    const readinessMode =
      scenarioRun.kind === "approval" || scenarioRun.kind === "codex-approval"
        ? "started"
        : "connected";
    await waitForSlackChannelStable(input.gateway as never, params.accountId, readinessMode);
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
        cfg,
        channelId: params.channelId,
        context,
        gatewayDebugDirPath: path.join(input.outputDir, "gateway-debug"),
        observedMessages,
        outputDir: input.outputDir,
        primaryModel,
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
