import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaBusState } from "./bus-state.js";
import { getQaProvider } from "./providers/index.js";
import { QaStateBackedTransportAdapter } from "./qa-transport.js";
import type {
  QaTransportActionName,
  QaTransportGatewayConfig,
  QaTransportGatewayClient,
  QaTransportReportParams,
} from "./qa-transport.js";
import { qaChannelPlugin } from "./runtime-api.js";

const QA_CHANNEL_ID = "qa-channel";
const QA_CHANNEL_ACCOUNT_ID = "default";
export const QA_CHANNEL_REQUIRED_PLUGIN_IDS = Object.freeze([QA_CHANNEL_ID]);
export const QA_CHANNEL_DEFAULT_SUITE_CONCURRENCY = 4;

async function waitForQaChannelReady(params: {
  gateway: QaTransportGatewayClient;
  timeoutMs?: number;
  pollIntervalMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const pollIntervalMs = params.pollIntervalMs ?? 500;
  const startedAt = Date.now();
  let lastAccountStatus = "no qa-channel accounts reported";
  let lastProbeError: string | null = null;

  while (Date.now() - startedAt < timeoutMs) {
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
      lastProbeError = null;
      lastAccountStatus = account
        ? JSON.stringify({
            accountId: account.accountId ?? null,
            running: account.running ?? null,
            restartPending: account.restartPending ?? null,
          })
        : "no qa-channel accounts reported";
      if (account?.running && account.restartPending !== true) {
        return;
      }
    } catch (error) {
      lastProbeError = formatErrorMessage(error);
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(
    [
      `timed out after ${timeoutMs}ms waiting for qa-channel ready`,
      `last status: ${lastAccountStatus}`,
      ...(lastProbeError ? [`last probe error: ${lastProbeError}`] : []),
    ].join("; "),
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
        visibleReplies: "automatic",
      },
    },
  };
}

function createQaChannelReportNotes(params: QaTransportReportParams) {
  const provider = getQaProvider(params.providerMode);
  return [
    provider.kind === "mock"
      ? `Runs against qa-channel + qa-lab bus + real gateway child + ${params.providerMode} provider.`
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
