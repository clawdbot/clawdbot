// Qa Lab plugin module implements qa channel transport behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaBusState } from "./bus-state.js";
import { getQaProvider } from "./providers/index.js";
import {
  QaStateBackedTransportAdapter,
  waitForQaTransportAccountReady,
  waitForQaTransportOutboundSequence,
} from "./qa-transport.js";
import type {
  QaTransportActionName,
  QaTransportGatewayConfig,
  QaTransportGatewayClient,
  QaTransportNativeCommandInput,
  QaTransportOutboundSequenceMatch,
  QaTransportPolicy,
  QaTransportReportParams,
} from "./qa-transport.js";

const QA_CHANNEL_ID = "qa-channel";
const QA_CHANNEL_ACCOUNT_ID = "default";
export const QA_CHANNEL_REQUIRED_PLUGIN_IDS = Object.freeze([QA_CHANNEL_ID]);
export const QA_CHANNEL_DEFAULT_SUITE_CONCURRENCY = 4;

export function createQaChannelGatewayConfig(params: {
  baseUrl: string;
  transportPolicy?: QaTransportPolicy;
}): QaTransportGatewayConfig {
  const senderAllowlist = params.transportPolicy?.senderAllowlist;
  return {
    channels: {
      [QA_CHANNEL_ID]: {
        enabled: true,
        baseUrl: params.baseUrl,
        botUserId: "openclaw",
        botDisplayName: "OpenClaw QA",
        allowFrom: senderAllowlist ? [...senderAllowlist] : ["*"],
        ...(senderAllowlist
          ? {
              groupPolicy: "allowlist" as const,
              groupAllowFrom: [...senderAllowlist],
            }
          : {}),
        ...(params.transportPolicy?.requireGroupMention
          ? {
              groups: {
                "*": {
                  requireMention: true,
                },
              },
            }
          : {}),
        pollTimeoutMs: 250,
      },
    },
    messages: {
      visibleReplies: "automatic",
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
    params.isolatedWorkers === true
      ? `Scenarios run in isolated gateway workers with concurrency ${params.concurrency}.`
      : "Scenarios run serially in one gateway worker.",
    "Scheduling scenarios verify stored schedules and execution behavior through the Gateway.",
  ];
}

async function handleQaChannelAction(params: {
  action: QaTransportActionName;
  args: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId?: string | null;
}) {
  const { qaChannelPlugin } = await import("openclaw/plugin-sdk/qa-channel");
  return await qaChannelPlugin.actions?.handleAction?.({
    channel: QA_CHANNEL_ID,
    action: params.action,
    cfg: params.cfg,
    accountId: params.accountId?.trim() || QA_CHANNEL_ACCOUNT_ID,
    params: params.args,
  });
}

class QaChannelTransport extends QaStateBackedTransportAdapter {
  readonly #transportPolicy?: QaTransportPolicy;

  constructor(state: QaBusState, transportPolicy?: QaTransportPolicy) {
    super({
      id: QA_CHANNEL_ID,
      label: "qa-channel + qa-lab bus",
      accountId: QA_CHANNEL_ACCOUNT_ID,
      requiredPluginIds: QA_CHANNEL_REQUIRED_PLUGIN_IDS,
      supportedActions: ["delete", "edit", "react", "thread-create"],
      state,
    });
    this.#transportPolicy = transportPolicy;
  }

  createGatewayConfig = ({ baseUrl }: { baseUrl: string }) =>
    createQaChannelGatewayConfig({ baseUrl, transportPolicy: this.#transportPolicy });
  waitReady = (params: {
    gateway: QaTransportGatewayClient;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) =>
    waitForQaTransportAccountReady({
      ...params,
      accountId: QA_CHANNEL_ACCOUNT_ID,
      channel: QA_CHANNEL_ID,
    });
  buildAgentDelivery = ({ target }: { target: string }) => ({
    channel: QA_CHANNEL_ID,
    replyChannel: QA_CHANNEL_ID,
    replyTo: target,
  });
  async sendNativeCommand(input: QaTransportNativeCommandInput): Promise<void> {
    const { command, ...message } = input;
    await this.sendInbound({
      ...message,
      text: `/${command}`,
      nativeCommand: { name: command },
    });
  }
  async waitForOutboundSequence(input: QaTransportOutboundSequenceMatch) {
    return await waitForQaTransportOutboundSequence({
      accountId: this.accountId,
      input,
      readEvents: () => this.state.getSnapshot().events,
    });
  }
  handleAction = handleQaChannelAction;
  createReportNotes = createQaChannelReportNotes;
}

export function createQaChannelTransport(state: QaBusState, transportPolicy?: QaTransportPolicy) {
  return new QaChannelTransport(state, transportPolicy);
}
