// Qa Lab plugin module implements Crabline channel-driver transport behavior against local provider servers.
import fs from "node:fs/promises";
import path from "node:path";
import {
  startOpenClawCrablineAdapter,
  type OpenClawCrablineChannelDriverSelection,
  type OpenClawCrablineInbound,
  type StartedOpenClawCrablineAdapter,
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
  resolveDiscordQaId,
  resolveTelegramQaSenderId,
} from "./crabline-provider-targets.js";
import { readQaJsonResponse } from "./ignored-response-body.js";
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
  rememberProviderTarget: (providerTargetKey: string, qaTarget: string) => void;
};

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

function formatLogicalQaTarget({ conversation, threadId }: QaBusInboundMessageInput) {
  const prefix = conversation.kind === "direct" ? "dm" : conversation.kind;
  return threadId ? `thread:${conversation.id}/${threadId}` : `${prefix}:${conversation.id}`;
}

function formatLogicalQaConversationTarget({ conversation }: QaBusInboundMessageInput) {
  const prefix = conversation.kind === "direct" ? "dm" : conversation.kind;
  return `${prefix}:${conversation.id}`;
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
  const label = `Crabline ${params.adapter.channel} inbound injection failed`;
  const result = await readQaJsonResponse<unknown>(response, release, label);
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
}

function createCrablineState(params: {
  adapter: StartedOpenClawCrablineAdapter;
  state: QaBusState;
}): QaCrablineTransportState {
  const baseState = params.state;
  const targetByProviderTarget = new Map<string, string>();
  const logicalRouteByTarget = new Map<string, { target: string; threadId?: string }>();
  const telegramMessageByProviderId = new Map<string, QaBusMessage>();
  const pendingTelegramMessagesByChat = new Map<string, QaBusMessage[]>();
  const outboundEvents: QaTransportOutboundEvent[] = [];

  return {
    reset() {
      baseState.reset();
      targetByProviderTarget.clear();
      logicalRouteByTarget.clear();
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
        const logicalRoute = logicalRouteByTarget.get(outbound.to);
        baseState.addOutboundMessage(
          logicalRoute
            ? {
                ...outbound,
                to: logicalRoute.target,
                ...(logicalRoute.threadId ? { threadId: logicalRoute.threadId } : {}),
              }
            : outbound,
        );
      }
    },
    async addInboundMessage(input: QaBusInboundMessageInput) {
      let providerInbound = params.adapter.createInbound({
        input: createCrablineProviderInboundInput(params.adapter, input),
      });
      if (
        params.adapter.channel === "telegram" &&
        input.threadId &&
        input.conversation.kind !== "direct" &&
        isRecord(providerInbound.providerBody)
      ) {
        // Crabline's Telegram server requires provider-native forum metadata before accepting a
        // topic. Scenario inputs carry only portable thread identity, so add that server fact here.
        providerInbound = {
          ...providerInbound,
          providerBody: {
            ...providerInbound.providerBody,
            chatType: "supergroup",
            isForum: true,
          },
        };
      }
      // Providers may coerce channel conversations to groups; preserve the scenario's logical
      // target so outbound waits and assertions still match the original input.
      const logicalTarget = formatLogicalQaTarget(input);
      targetByProviderTarget.set(providerInbound.providerTargetKey, logicalTarget);
      logicalRouteByTarget.set(logicalTarget, {
        target: formatLogicalQaConversationTarget(input),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      });
      const providerMessageId = await postCrablineInbound({
        adapter: params.adapter,
        providerInbound,
      });
      return baseState.addInboundMessage(
        {
          ...input,
          conversation: resolveCrablineStateConversation({
            adapter: params.adapter,
            input,
            providerInbound,
          }),
          ...(input.threadId
            ? { threadId: input.threadId }
            : providerInbound.threadId
              ? { threadId: providerInbound.threadId }
              : {}),
        },
        providerMessageId,
      );
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
  readonly #adapter: StartedOpenClawCrablineCorrelatedAdapter;
  readonly #selection: OpenClawCrablineChannelDriverSelection;
  readonly #transportPolicy?: QaTransportPolicy;
  readonly #state: QaCrablineTransportState;
  #cleanupPromise?: Promise<void>;
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
    if (this.#selection.channel === "discord") {
      const discord = config.channels?.discord;
      const senderAllowlist = this.#transportPolicy?.senderAllowlist?.map(resolveDiscordQaId);
      // Crabline's local binding opens DMs, so the real Discord plugin also requires the matching
      // allowlist. Keep an explicit sender restriction; otherwise its open policy uses a wildcard.
      const dmAllowlist = senderAllowlist ?? discord?.allowFrom ?? ["*"];
      const discordWithOpenDms = {
        ...discord,
        allowFrom: [...dmAllowlist],
        ...(dmAllowlist.includes("*") ? {} : { dmPolicy: "allowlist" as const }),
      };
      const wildcardGuild = discord?.guilds?.["*"];
      const wildcardChannel = wildcardGuild?.channels?.["*"];
      if (!this.#transportPolicy?.requireGroupMention && !senderAllowlist) {
        return {
          ...config,
          channels: { ...config.channels, discord: discordWithOpenDms },
        } as QaTransportGatewayConfig;
      }
      return {
        ...config,
        channels: {
          ...config.channels,
          discord: {
            ...discordWithOpenDms,
            ...(senderAllowlist ? { groupPolicy: "allowlist" as const } : {}),
            guilds: {
              ...discord?.guilds,
              "*": {
                ...wildcardGuild,
                ...(senderAllowlist ? { users: [...senderAllowlist] } : {}),
                channels: {
                  ...wildcardGuild?.channels,
                  "*": {
                    ...wildcardChannel,
                    ...(this.#transportPolicy?.requireGroupMention ? { requireMention: true } : {}),
                  },
                },
              },
            },
          },
        },
      } as QaTransportGatewayConfig;
    }
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

  waitReady = (params: Parameters<QaStateBackedTransportAdapter["waitReady"]>[0]) =>
    waitForQaTransportAccountReady({
      ...params,
      accountId: this.#adapter.accountId,
      channel: this.#adapter.channel,
    });

  buildAgentDelivery = ({ target }: { target: string }) => {
    const { delivery, providerTargetKey } = createCrablineProviderDelivery(this.#adapter, target);
    this.#state.rememberProviderTarget(providerTargetKey, target);
    return delivery;
  };

  createRuntimeEnvPatch = () => {
    const env = this.#adapter.createProviderReadinessEnv({});
    if (this.#adapter.manifest.provider !== "discord") {
      return env;
    }
    const gatewayUrl = new URL(this.#adapter.manifest.endpoints.gatewayUrl);
    return {
      ...env,
      DISCORD_REST_API_BASE_URL: `${this.#adapter.manifest.endpoints.apiRoot}/v10`,
      DISCORD_GATEWAY_BOT_URL: this.#adapter.manifest.endpoints.gatewayBotUrl,
      DISCORD_GATEWAY_ORIGIN: gatewayUrl.origin,
    };
  };

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

  #cleanupTransport() {
    this.#cleanupPromise ??= this.#state.cleanup();
    void this.#cleanupPromise.catch(() => {
      this.#cleanupPromise = undefined;
    });
    return this.#cleanupPromise;
  }

  async cleanup() {
    if (this.#selection.channel !== "discord") {
      await this.#cleanupTransport();
    }
  }

  async cleanupAfterGatewayStop() {
    if (this.#selection.channel === "discord") {
      await this.#cleanupTransport();
    }
  }
}

export async function createQaCrablineTransportAdapter(params: {
  outputDir: string;
  transportPolicy?: QaTransportPolicy;
  selection: OpenClawCrablineChannelDriverSelection;
  state?: QaBusState;
}) {
  const requiresGroupPolicy =
    params.transportPolicy?.requireGroupMention === true ||
    params.transportPolicy?.senderAllowlist !== undefined;
  if (
    params.selection.channel !== "telegram" &&
    params.selection.channel !== "discord" &&
    requiresGroupPolicy
  ) {
    throw new Error(
      `Crabline ${params.selection.channel} does not support the requested group transport policy; use the Crabline Telegram or Discord bridge, or a live channel adapter`,
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
