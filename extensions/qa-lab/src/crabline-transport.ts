// Qa Lab plugin module implements Crabline local-provider transport behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  startOpenClawCrablineAdapter,
  type OpenClawCrablineChannelDriverSelection,
  type OpenClawCrablineInbound,
  type StartedOpenClawCrablineAdapter,
} from "@openclaw/crabline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  isRecord,
  normalizeStringifiedOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { createQaBusState, type QaBusState } from "./bus-state.js";
import { QaSuiteInfraError } from "./errors.js";
import {
  QaStateBackedTransportAdapter,
  waitForQaTransportOutboundSequence,
} from "./qa-transport.js";
import type {
  QaTransportActionName,
  QaTransportGatewayClient,
  QaTransportGatewayConfig,
  QaTransportNativeCommandInput,
  QaTransportOutboundEvent,
  QaTransportOutboundSequenceMatch,
  QaTransportPolicy,
  QaTransportReportParams,
  QaTransportState,
} from "./qa-transport.js";
import type {
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusOutboundMessageInput,
} from "./runtime-api.js";

const CRABLINE_TRANSPORT_ID = "crabline";
const TELEGRAM_QA_DRIVER_ID = "100001";
const TELEGRAM_QA_OBSERVER_ID = "100002";

type QaCrablineTransportState = QaTransportState & {
  cleanup: () => Promise<void>;
  getOutboundEvents: () => Promise<readonly QaTransportOutboundEvent[]>;
  observeEvent: (event: unknown) => void;
  rememberProviderTarget: (providerTargetKey: string, qaTarget: string) => void;
};

function formatLogicalQaTarget({ conversation, threadId }: QaBusInboundMessageInput) {
  const prefix = conversation.kind === "direct" ? "dm" : conversation.kind;
  return threadId ? `thread:${conversation.id}/${threadId}` : `${prefix}:${conversation.id}`;
}

const TELEGRAM_LIFECYCLE_METHOD_RE = /\/(sendMessage|editMessageText|deleteMessage)$/u;

function resolveTelegramQaSenderId(senderId: string) {
  return senderId === "driver"
    ? TELEGRAM_QA_DRIVER_ID
    : senderId === "observer"
      ? TELEGRAM_QA_OBSERVER_ID
      : senderId;
}

function readTelegramLifecycleEvent(params: {
  cursor: number;
  event: unknown;
  messageByProviderId: Map<string, QaBusMessage>;
  pendingByChat: Map<string, QaBusMessage[]>;
}): QaTransportOutboundEvent | null {
  if (!isRecord(params.event) || params.event.type !== "api") {
    return null;
  }
  const pathValue = readStringValue(params.event.path);
  const method = pathValue ? TELEGRAM_LIFECYCLE_METHOD_RE.exec(pathValue)?.[1] : undefined;
  if (!method || !isRecord(params.event.body)) {
    return null;
  }
  const chatId = normalizeStringifiedOptionalString(params.event.body.chat_id);
  if (!chatId) {
    return null;
  }
  const providerMessageId = normalizeStringifiedOptionalString(params.event.body.message_id);
  const providerKey = providerMessageId ? `${chatId}:${providerMessageId}` : null;
  let previous = providerKey ? params.messageByProviderId.get(providerKey) : undefined;
  if (!previous && providerKey && providerMessageId) {
    const pending = params.pendingByChat.get(chatId) ?? [];
    if (pending.length === 1) {
      const pendingMessage = pending[0];
      if (!pendingMessage) {
        return null;
      }
      previous = pendingMessage;
      pendingMessage.id = providerMessageId;
      params.messageByProviderId.set(providerKey, pendingMessage);
      params.pendingByChat.delete(chatId);
    }
  }
  const text = readStringValue(params.event.body.text) ?? previous?.text ?? "";
  if (!text && method !== "deleteMessage") {
    return null;
  }
  const threadId =
    normalizeStringifiedOptionalString(params.event.body.message_thread_id) ?? previous?.threadId;
  const message: QaBusMessage = {
    id: providerMessageId ?? previous?.id ?? `crabline-${params.cursor}`,
    accountId: "default",
    direction: "outbound",
    conversation: {
      id: chatId,
      kind: chatId.startsWith("-") ? "group" : "direct",
    },
    senderId: "openclaw",
    senderName: "OpenClaw QA",
    text,
    timestamp: Date.now(),
    ...(threadId ? { threadId } : {}),
    ...(method === "deleteMessage" ? { deleted: true } : {}),
    ...(method === "editMessageText" ? { editedAt: Date.now() } : {}),
    reactions: [],
  };
  if (method === "sendMessage") {
    const pending = params.pendingByChat.get(chatId) ?? [];
    pending.push(message);
    params.pendingByChat.set(chatId, pending);
  } else if (providerKey) {
    params.messageByProviderId.set(providerKey, message);
  }
  return {
    cursor: params.cursor,
    kind: method === "sendMessage" ? "sent" : method === "editMessageText" ? "edited" : "deleted",
    message,
  };
}

async function waitForCrablineReady(params: {
  accountId: string;
  channel: string;
  gateway: QaTransportGatewayClient;
  timeoutMs?: number;
  pollIntervalMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? 45_000;
  const pollIntervalMs = params.pollIntervalMs ?? 500;
  const startedAt = Date.now();
  let lastAccountStatus = `no ${params.channel} accounts reported`;
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
      const accounts = payload.channelAccounts?.[params.channel] ?? [];
      const account = accounts.find((entry) => entry.accountId === params.accountId) ?? accounts[0];
      lastProbeError = null;
      lastAccountStatus = account
        ? JSON.stringify({
            accountId: account.accountId ?? null,
            running: account.running ?? null,
            restartPending: account.restartPending ?? null,
          })
        : `no ${params.channel} accounts reported`;
      if (account?.running && account.restartPending !== true) {
        return;
      }
    } catch (error) {
      lastProbeError = formatErrorMessage(error);
    }
    await sleep(pollIntervalMs);
  }

  throw new QaSuiteInfraError(
    "transport_ready_timeout",
    [
      `timed out after ${timeoutMs}ms waiting for ${params.channel} ready`,
      `last status: ${lastAccountStatus}`,
      ...(lastProbeError ? [`last probe error: ${lastProbeError}`] : []),
    ].join("; "),
  );
}

async function postCrablineInbound(params: {
  adapter: StartedOpenClawCrablineAdapter;
  providerInbound: OpenClawCrablineInbound;
}) {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.adapter.manifest.endpoints.adminInboundUrl,
    init: {
      body: JSON.stringify(params.providerInbound.providerBody),
      headers: {
        "content-type": "application/json",
        "x-crabline-admin-token": params.adapter.manifest.adminToken,
      },
      method: "POST",
    },
    policy: { allowPrivateNetwork: true },
    auditContext: `qa-lab-crabline-${params.adapter.channel}-inbound`,
  });
  try {
    if (!response.ok) {
      throw new Error(
        `Crabline ${params.adapter.channel} inbound injection failed with HTTP ${response.status}.`,
      );
    }
    const result: unknown = await response.json();
    if (params.adapter.channel === "matrix" && isRecord(result) && isRecord(result.event)) {
      return readStringValue(result.event.event_id);
    }
    if (params.adapter.channel === "slack" && isRecord(result) && isRecord(result.message)) {
      return readStringValue(result.message.ts);
    }
    if (
      params.adapter.channel === "telegram" &&
      isRecord(result) &&
      isRecord(result.update) &&
      isRecord(result.update.message)
    ) {
      return normalizeStringifiedOptionalString(result.update.message.message_id);
    }
    return undefined;
  } finally {
    await release();
  }
}

function createCrablineState(params: {
  adapter: StartedOpenClawCrablineAdapter;
  state: QaBusState;
}): QaCrablineTransportState {
  const baseState = params.state;
  const targetByProviderTarget = new Map<string, string>();
  const telegramMessageByProviderId = new Map<string, QaBusMessage>();
  const pendingTelegramMessagesByChat = new Map<string, QaBusMessage[]>();
  const outboundEvents: QaTransportOutboundEvent[] = [];

  return {
    reset() {
      baseState.reset();
      targetByProviderTarget.clear();
      telegramMessageByProviderId.clear();
      pendingTelegramMessagesByChat.clear();
      outboundEvents.length = 0;
    },
    getSnapshot: baseState.getSnapshot.bind(baseState),
    async getOutboundEvents() {
      return outboundEvents;
    },
    observeEvent(event) {
      if (params.adapter.channel === "telegram") {
        const lifecycle = readTelegramLifecycleEvent({
          cursor: outboundEvents.length + 1,
          event,
          messageByProviderId: telegramMessageByProviderId,
          pendingByChat: pendingTelegramMessagesByChat,
        });
        if (lifecycle) {
          outboundEvents.push(lifecycle);
        }
      }
      const normalizedEvent =
        params.adapter.channel === "telegram" &&
        isRecord(event) &&
        isRecord(event.body) &&
        normalizeStringifiedOptionalString(event.body.chat_id)
          ? {
              ...event,
              body: {
                ...event.body,
                chat_id: normalizeStringifiedOptionalString(event.body.chat_id),
              },
            }
          : event;
      const outbound = params.adapter.createOutboundFromRecorderEvent({
        event: normalizedEvent,
        targetByProviderTarget,
      }) as QaBusOutboundMessageInput | null;
      if (outbound) {
        baseState.addOutboundMessage(outbound);
      }
    },
    async addInboundMessage(input: QaBusInboundMessageInput) {
      const providerSenderId =
        params.adapter.channel === "telegram"
          ? resolveTelegramQaSenderId(input.senderId)
          : input.senderId;
      const providerInbound = params.adapter.createInbound({
        input: {
          ...input,
          conversation: {
            ...input.conversation,
            kind: input.conversation.kind === "direct" ? "direct" : "group",
          },
          senderId: providerSenderId,
        },
      });
      // Providers may coerce channel conversations to groups; preserve the scenario's logical
      // target so outbound waits and assertions still match the original input.
      targetByProviderTarget.set(providerInbound.providerTargetKey, formatLogicalQaTarget(input));
      const providerMessageId = await postCrablineInbound({
        adapter: params.adapter,
        providerInbound,
      });
      const message = baseState.addInboundMessage({
        ...input,
        conversation: providerInbound.stateConversation,
        ...(providerInbound.threadId ? { threadId: providerInbound.threadId } : {}),
      });
      if (providerMessageId) {
        message.id = providerMessageId;
      }
      return message;
    },
    rememberProviderTarget(providerTargetKey, qaTarget) {
      targetByProviderTarget.set(providerTargetKey, qaTarget);
    },
    addOutboundMessage: baseState.addOutboundMessage.bind(baseState),
    readMessage: baseState.readMessage.bind(baseState),
    searchMessages: baseState.searchMessages.bind(baseState),
    waitFor: baseState.waitFor.bind(baseState),
    async cleanup() {
      await params.adapter.close();
    },
  };
}

class QaCrablineTransport extends QaStateBackedTransportAdapter {
  readonly #adapter: StartedOpenClawCrablineAdapter;
  readonly #selection: OpenClawCrablineChannelDriverSelection;
  readonly #transportPolicy?: QaTransportPolicy;
  readonly #state: QaCrablineTransportState;
  readonly sendNativeCommand?: (input: QaTransportNativeCommandInput) => Promise<void>;
  readonly waitForOutboundSequence?: (input: QaTransportOutboundSequenceMatch) => Promise<{
    events: QaTransportOutboundEvent[];
    final: QaBusMessage;
  }>;

  constructor(params: {
    adapter: StartedOpenClawCrablineAdapter;
    transportPolicy?: QaTransportPolicy;
    selection: OpenClawCrablineChannelDriverSelection;
    state: QaCrablineTransportState;
  }) {
    super({
      id: CRABLINE_TRANSPORT_ID,
      label: `crabline local ${params.selection.channel}`,
      accountId: params.adapter.accountId,
      requiredPluginIds: params.adapter.requiredPluginIds,
      state: params.state,
    });
    this.#adapter = params.adapter;
    this.#selection = params.selection;
    this.#transportPolicy = params.transportPolicy;
    this.#state = params.state;
    if (params.selection.channel === "telegram") {
      this.sendNativeCommand = async (input) => {
        const { command, ...message } = input;
        await this.sendInbound({
          ...message,
          text: `/${command}`,
          nativeCommand: { name: command },
        });
      };
      this.waitForOutboundSequence = async (input) =>
        await waitForQaTransportOutboundSequence({
          input,
          readEvents: () => this.#state.getOutboundEvents(),
        });
    }
  }

  createGatewayConfig = (params: { baseUrl: string }): QaTransportGatewayConfig => {
    const config = this.#adapter.createGatewayConfig(params) as OpenClawConfig;
    if (this.#selection.channel !== "telegram") {
      return config as QaTransportGatewayConfig;
    }
    const senderAllowlist = this.#transportPolicy?.senderAllowlist?.map(resolveTelegramQaSenderId);
    if (!this.#transportPolicy?.requireGroupMention && !senderAllowlist) {
      return config as QaTransportGatewayConfig;
    }
    return {
      ...config,
      channels: {
        ...config.channels,
        telegram: {
          ...config.channels?.telegram,
          ...(senderAllowlist
            ? {
                allowFrom: [...senderAllowlist],
                groupAllowFrom: [...senderAllowlist],
                groupPolicy: "allowlist" as const,
              }
            : {}),
          groups: {
            ...config.channels?.telegram?.groups,
            "*": {
              ...config.channels?.telegram?.groups?.["*"],
              ...(this.#transportPolicy?.requireGroupMention ? { requireMention: true } : {}),
            },
          },
        },
      },
    } as QaTransportGatewayConfig;
  };

  waitReady = (params: {
    gateway: QaTransportGatewayClient;
    timeoutMs?: number;
    pollIntervalMs?: number;
  }) =>
    waitForCrablineReady({
      ...params,
      accountId: this.#adapter.accountId,
      channel: this.#adapter.channel,
    });

  buildAgentDelivery = ({ target }: { target: string }) => {
    const delivery = this.#adapter.createAgentDelivery({ target });
    this.#state.rememberProviderTarget(delivery.to ?? delivery.replyTo, target);
    return delivery;
  };

  createRuntimeEnvPatch = () => this.#adapter.createChannelDriverSmokeEnv({});

  handleAction = async (_params: {
    action: QaTransportActionName;
    args: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => {
    throw new Error(`Crabline local-provider transport does not support ${_params.action} yet.`);
  };

  createReportNotes = (_params: QaTransportReportParams) => [
    `Runs OpenClaw's ${this.#selection.channel} channel plugin against a Crabline local provider server.`,
    "No live channel service or external credential lease is required.",
  ];

  async cleanup() {
    await this.#state.cleanup();
  }
}

export async function createQaCrablineTransportAdapter(params: {
  outputDir: string;
  transportPolicy?: QaTransportPolicy;
  selection: OpenClawCrablineChannelDriverSelection;
  state?: QaBusState;
}) {
  const requiresTelegramPolicy =
    params.transportPolicy?.requireGroupMention === true ||
    params.transportPolicy?.senderAllowlist !== undefined;
  if (params.selection.channel !== "telegram" && requiresTelegramPolicy) {
    throw new Error(
      `Crabline ${params.selection.channel} does not support the requested group transport policy; use the Crabline Telegram bridge or a live channel adapter`,
    );
  }
  const recorderPath = path.join(
    params.outputDir,
    "artifacts",
    "crabline",
    `${params.selection.channel}-fake-provider.jsonl`,
  );
  await fs.mkdir(path.dirname(recorderPath), { recursive: true });
  let observeEvent = (_event: unknown) => {};
  const adapter = await startOpenClawCrablineAdapter({
    channel: params.selection.channel,
    onEvent: (event) => observeEvent(event),
    openclawConfig: {},
    recorderPath,
  });

  const state = createCrablineState({
    adapter,
    state: params.state ?? createQaBusState(),
  });
  observeEvent = state.observeEvent;
  return new QaCrablineTransport({
    adapter,
    transportPolicy: params.transportPolicy,
    selection: params.selection,
    state,
  });
}
