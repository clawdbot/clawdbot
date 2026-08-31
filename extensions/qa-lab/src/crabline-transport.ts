// Qa Lab plugin module implements Crabline channel-driver transport behavior against local provider servers.
import fs from "node:fs/promises";
import path from "node:path";
import {
  startOpenClawCrablineAdapter,
  type OpenClawCrablineChannelDriverSelection,
  type OpenClawCrablineInbound,
  type StartedOpenClawCrablineCorrelatedAdapter,
} from "@openclaw/crabline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  isRecord,
  normalizeStringifiedOptionalString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { createQaBusState, type QaBusState } from "./bus-state.js";
import {
  createCrablineProviderDelivery,
  createCrablineProviderInboundInput,
  resolveCrablineStateConversation,
} from "./crabline-provider-targets.js";
import { readQaJsonResponse } from "./ignored-response-body.js";
import { buildQaConversationTarget, parseQaTarget } from "./qa-bus-protocol.js";
import {
  QaStateBackedTransportAdapter,
  waitForQaTransportAccountReady,
  waitForQaTransportOutboundSequence,
} from "./qa-transport.js";
import type {
  QaTransportActionName,
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

type QaCrablineTransportState = QaTransportState & {
  cleanup: () => Promise<void>;
  getOutboundEvents: () => Promise<readonly QaTransportOutboundEvent[]>;
  observeEvent: (event: unknown) => void;
  rememberProviderTarget: (providerTargetKey: string, target: QaCrablineTarget) => void;
};

type QaCrablineTarget = Pick<QaBusInboundMessageInput, "conversation" | "threadId">;

function qaTargetForInput(input: QaBusInboundMessageInput): QaCrablineTarget {
  return {
    conversation: { ...input.conversation },
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };
}

function normalizeCrablineSignalGatewayConfig(config: OpenClawConfig): OpenClawConfig {
  const signal = config.channels?.signal as unknown;
  if (!isRecord(signal)) {
    return config;
  }
  const httpUrl = readStringValue(signal.httpUrl);
  if (!httpUrl) {
    return config;
  }

  // Crabline still emits the retired Signal transport fields. Keep that dependency detail at
  // this adapter boundary so the Gateway receives only the account-owned canonical shape.
  const canonicalSignal = { ...signal };
  delete canonicalSignal.apiMode;
  delete canonicalSignal.autoStart;
  delete canonicalSignal.httpUrl;
  return {
    ...config,
    channels: {
      ...config.channels,
      signal: {
        ...canonicalSignal,
        transport: {
          kind: "external-native",
          url: httpUrl,
        },
      },
    },
  } as OpenClawConfig;
}

const TELEGRAM_LIFECYCLE_METHOD_RE = /\/(sendMessage|editMessageText|deleteMessage)$/u;

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

async function postCrablineInbound(params: {
  adapter: StartedOpenClawCrablineCorrelatedAdapter;
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
  const label = `Crabline ${params.adapter.channel} inbound injection failed`;
  const result = await readQaJsonResponse<unknown>(response, release, label);
  let providerMessageId: string | undefined;
  if (params.adapter.channel === "matrix" && isRecord(result) && isRecord(result.event)) {
    providerMessageId = readStringValue(result.event.event_id);
  } else if (params.adapter.channel === "slack" && isRecord(result) && isRecord(result.message)) {
    providerMessageId = readStringValue(result.message.ts);
  } else if (
    params.adapter.channel === "telegram" &&
    isRecord(result) &&
    isRecord(result.update) &&
    isRecord(result.update.message)
  ) {
    providerMessageId = normalizeStringifiedOptionalString(result.update.message.message_id);
  }
  return { providerMessageId, response: result };
}

function createCrablineState(params: {
  adapter: StartedOpenClawCrablineCorrelatedAdapter;
  state: QaBusState;
}): QaCrablineTransportState {
  const baseState = params.state;
  const targetByProviderTarget = new Map<string, QaCrablineTarget>();
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
      const observation = params.adapter.createOutboundObservation({ event: normalizedEvent });
      const target = observation?.providerTargetKeys
        .map((key) => targetByProviderTarget.get(key))
        .find((candidate) => candidate !== undefined);
      const outbound: QaBusOutboundMessageInput | null = observation
        ? target
          ? {
              accountId: observation.accountId,
              senderId: observation.senderId,
              senderName: observation.senderName,
              text: observation.text,
              to: buildQaConversationTarget({
                chatType: target.conversation.kind,
                conversationId: target.conversation.id,
              }),
              threadId: target.threadId,
            }
          : observation.fallbackTarget
            ? {
                accountId: observation.accountId,
                senderId: observation.senderId,
                senderName: observation.senderName,
                text: observation.text,
                to: observation.fallbackTarget,
              }
            : null
        : null;
      if (outbound) {
        baseState.addOutboundMessage(outbound);
      }
    },
    async addInboundMessage(input: QaBusInboundMessageInput) {
      const providerInbound = params.adapter.createInbound({
        input: createCrablineProviderInboundInput(params.adapter, input),
      });
      const ingress = await postCrablineInbound({
        adapter: params.adapter,
        providerInbound,
      });
      // Register only the provider identity confirmed by successful ingress. Provider servers may
      // realize a symbolic target as a different native conversation than the provisional input.
      targetByProviderTarget.set(
        params.adapter.resolveInboundProviderTargetKey({
          inbound: providerInbound,
          response: ingress.response,
        }),
        qaTargetForInput(input),
      );
      return baseState.addInboundMessage(
        {
          ...input,
          conversation: resolveCrablineStateConversation({
            adapter: params.adapter,
            input,
            providerInbound,
          }),
        },
        ingress.providerMessageId,
      );
    },
    rememberProviderTarget(providerTargetKey, target) {
      targetByProviderTarget.set(providerTargetKey, target);
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
  readonly #adapter: StartedOpenClawCrablineCorrelatedAdapter;
  readonly #selection: OpenClawCrablineChannelDriverSelection;
  readonly #transportPolicy?: QaTransportPolicy;
  readonly #state: QaCrablineTransportState;
  readonly sendNativeCommand?: (input: QaTransportNativeCommandInput) => Promise<void>;
  readonly waitForOutboundSequence?: (input: QaTransportOutboundSequenceMatch) => Promise<{
    events: QaTransportOutboundEvent[];
    final: QaBusMessage;
  }>;

  constructor(params: {
    adapter: StartedOpenClawCrablineCorrelatedAdapter;
    transportPolicy?: QaTransportPolicy;
    selection: OpenClawCrablineChannelDriverSelection;
    state: QaCrablineTransportState;
  }) {
    super({
      id: "crabline",
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
          nativeCommand: { name: command.split(/\s+/u, 1)[0] ?? command },
        });
      };
      this.waitForOutboundSequence = async (input) =>
        await waitForQaTransportOutboundSequence({
          accountId: this.accountId,
          input,
          readEvents: () => this.#state.getOutboundEvents(),
        });
    }
  }

  createGatewayConfig = (params: { baseUrl: string }): QaTransportGatewayConfig => {
    const rawConfig = this.#adapter.createGatewayConfig(params) as OpenClawConfig;
    const config =
      this.#selection.channel === "signal"
        ? normalizeCrablineSignalGatewayConfig(rawConfig)
        : rawConfig;
    if (this.#selection.channel !== "telegram") {
      return config as QaTransportGatewayConfig;
    }
    const senderAllowlist = this.#transportPolicy?.senderAllowlist?.map(
      (senderId) =>
        this.#adapter.createAgentDelivery({ target: `dm:${senderId}` }).providerTargetKey,
    );
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

  waitReady = (params: Parameters<QaStateBackedTransportAdapter["waitReady"]>[0]) =>
    waitForQaTransportAccountReady({
      ...params,
      accountId: this.#adapter.accountId,
      channel: this.#adapter.channel,
    });

  buildAgentDelivery = ({ target, threadId }: { target: string; threadId?: string }) => {
    const parsed = parseQaTarget(target);
    if (parsed.threadId && threadId && parsed.threadId !== threadId) {
      throw new Error("Crabline delivery received conflicting thread targets");
    }
    const logicalTarget = {
      conversation: { id: parsed.conversationId, kind: parsed.chatType },
      threadId: threadId ?? parsed.threadId,
    };
    const { delivery, providerTargetKey } = createCrablineProviderDelivery(
      this.#adapter,
      buildQaConversationTarget({
        chatType: logicalTarget.conversation.kind,
        conversationId: logicalTarget.conversation.id,
      }),
      logicalTarget.threadId,
    );
    this.#state.rememberProviderTarget(providerTargetKey, logicalTarget);
    return {
      ...delivery,
      ...(logicalTarget.threadId ? { threadId: logicalTarget.threadId } : {}),
    };
  };

  createRuntimeEnvPatch = () => this.#adapter.createProviderReadinessEnv({});

  handleAction = async (_params: {
    action: QaTransportActionName;
    args: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => {
    throw new Error(`Crabline channel-driver transport does not support ${_params.action} yet.`);
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
    `${params.selection.channel}-provider-server.jsonl`,
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
