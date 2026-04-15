import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { QaBusState } from "./bus-state.js";
import { QaStateBackedTransportAdapter, waitForQaTransportCondition } from "./qa-transport.js";
import type {
  QaTransportActionName,
  QaTransportGatewayConfig,
  QaTransportGatewayClient,
  QaTransportReportParams,
} from "./qa-transport.js";
import { qaChannelPlugin } from "./runtime-api.js";

export const QA_CHANNEL_ID = "qa-channel";
export const QA_CHANNEL_ACCOUNT_ID = "default";
export const QA_CHANNEL_REQUIRED_PLUGIN_IDS = Object.freeze([QA_CHANNEL_ID]);

async function waitForQaChannelReady(params: {
  gateway: QaTransportGatewayClient;
  timeoutMs?: number;
}) {
  await waitForQaTransportCondition(
    async () => {
      try {
        const payload = (await params.gateway.call(
          "channels.status",
          { probe: false, timeoutMs: 2_000 },
          { timeoutMs: 5_000 },
        )) as {
          channelAccounts?: Record<
            string,
            Array<{
              accountId?: string;
              running?: boolean;
              restartPending?: boolean;
            }>
          >;
        };
        const accounts = payload.channelAccounts?.[QA_CHANNEL_ID] ?? [];
        const account =
          accounts.find((entry) => entry.accountId === QA_CHANNEL_ACCOUNT_ID) ?? accounts[0];
        return account?.running && account.restartPending !== true ? true : undefined;
      } catch {
        return undefined;
      }
    },
    params.timeoutMs ?? 45_000,
    500,
  );
}

export function createQaChannelGatewayConfig(params: {
  baseUrl: string;
}): QaTransportGatewayConfig {
  return {
    channels: {
      [QA_CHANNEL_ID]: {
        enabled: true,
        baseUrl: params.baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
        allowFrom: ["*"],
        pollTimeoutMs: 250,
      },
    },
    messages: {
      groupChat: {
        mentionPatterns: ["\\b@?openclaw\\b"],
      },
    },
  };
}

function createQaChannelReportNotes(params: QaTransportReportParams) {
  return [
    params.providerMode === "mock-openai"
      ? "Runs against qa-channel + qa-lab bus + real gateway child + mock OpenAI provider."
      : `Runs against qa-channel + qa-lab bus + real gateway child + live frontier models (${params.primaryModel}, ${params.alternateModel})${params.fastMode ? " with fast mode enabled" : ""}.`,
    params.concurrency > 1
      ? `Scenarios run in isolated gateway workers with concurrency ${params.concurrency}.`
      : "Scenarios run serially in one gateway worker.",
    "Cron uses a one-minute schedule assertion plus forced execution for fast verification.",
  ];
}

async function handleQaChannelAction(params: {
  action: QaTransportActionName;
  args: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  return await qaChannelPlugin.actions?.handleAction?.({
    channel: QA_CHANNEL_ID,
    action: params.action,
    cfg: params.cfg,
    accountId: params.accountId?.trim() || QA_CHANNEL_ACCOUNT_ID,
    params: params.args,
  });
}

class QaChannelTransport extends QaStateBackedTransportAdapter {
  constructor(state: QaBusState) {
    super({
      id: QA_CHANNEL_ID,
      label: "qa-channel + qa-lab bus",
      accountId: QA_CHANNEL_ACCOUNT_ID,
      requiredPluginIds: QA_CHANNEL_REQUIRED_PLUGIN_IDS,
      state,
    });
  }

  createGatewayConfig = createQaChannelGatewayConfig;
  waitReady = waitForQaChannelReady;
  buildAgentDelivery = ({ target }: { target: string }) => ({
    channel: QA_CHANNEL_ID,
    replyChannel: QA_CHANNEL_ID,
    replyTo: target,
  });
  handleAction = handleQaChannelAction;
  createReportNotes = createQaChannelReportNotes;
}

export function createQaChannelTransport(state: QaBusState) {
  return new QaChannelTransport(state);
}
