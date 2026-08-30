import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  assertQaGatewayCredentialLeaseQuarantine,
  shouldRetainQaGatewayCredentialLease,
} from "../../gateway-process-boundary.js";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import { buildTelegramQaConfig, waitForTelegramChannelRunning } from "./telegram-api.runtime.js";
import { TelegramUserbotDriver, type TelegramUserbotUpdate } from "./userbot-driver.runtime.js";
import {
  loadTelegramUserbotSkillRuntime,
  type TelegramTestCredential,
} from "./userbot-skill.runtime.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;

const TELEGRAM_QA_DIAGNOSTIC_COUNT_LIMIT = 9_999;

type TelegramQaObserverState = {
  filteredCount: number;
  matchedCount: number;
  relevantUpdateKinds: Set<"edit" | "message">;
  updateCount: number;
};

function renderTelegramQaDiagnosticCount(value: number) {
  return value > TELEGRAM_QA_DIAGNOSTIC_COUNT_LIMIT
    ? `${TELEGRAM_QA_DIAGNOSTIC_COUNT_LIMIT}+`
    : String(value);
}

function describeTelegramQaObserverState(state: TelegramQaObserverState) {
  const updateKinds =
    state.relevantUpdateKinds.size > 0 ? [...state.relevantUpdateKinds] : ["none"];
  return [
    `telegram userbot updates=${renderTelegramQaDiagnosticCount(state.updateCount)}`,
    `filtered=${renderTelegramQaDiagnosticCount(state.filteredCount)}`,
    `matched=${renderTelegramQaDiagnosticCount(state.matchedCount)}`,
    `update kinds=[${updateKinds.join(",")}]`,
  ].join("; ");
}

function renderTelegramQaInboundText(
  input: { text: string; nativeCommand?: { name: string } },
  botUsername: string,
) {
  const commandName = input.nativeCommand?.name.trim().toLowerCase();
  const renderedText = input.text.replaceAll("@openclaw", `@${botUsername}`);
  const commandToken = renderedText.match(/^\S+/u)?.[0];
  return commandName && commandToken?.toLowerCase() === `/${commandName}`
    ? `/${commandName}@${botUsername}${renderedText.slice(commandToken.length)}`
    : renderedText;
}

async function releaseTelegramCredential(params: {
  heartbeat: { stop(): Promise<void> };
  release(): Promise<void>;
}) {
  try {
    await params.heartbeat.stop();
  } finally {
    await params.release();
  }
}

export async function createTelegramQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const options = context.adapterOptions ?? {};
  const skillRuntime = await loadTelegramUserbotSkillRuntime({ repoRoot: options.repoRoot });
  const credentialLease = await acquireQaCredentialLease<TelegramTestCredential>({
    kind: "telegram-test-userbot",
    source: options.credentialSource || "convex",
    role: options.credentialRole,
    resolveEnvPayload: () => {
      throw new Error("Telegram live QA requires a Convex-leased Test Server userbot.");
    },
    parsePayload: (payload) => skillRuntime.parseCredential(payload),
  });
  try {
    assertQaGatewayCredentialLeaseQuarantine(credentialLease);
  } catch (error) {
    await credentialLease.release();
    throw error;
  }
  const heartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
  const leaseHealth = {
    assertHealthy: () => heartbeat.throwIfFailed(),
    whenUnhealthy: heartbeat.whenFailed,
  };
  let leaseReleased = false;
  const releaseCredentialLease = async () => {
    if (leaseReleased) {
      return;
    }
    await releaseTelegramCredential({ heartbeat, release: () => credentialLease.release() });
    leaseReleased = true;
  };
  let stateRoot: string | undefined;
  let apiProxy: Awaited<ReturnType<typeof skillRuntime.startApiProxy>> | undefined;
  let userbot: TelegramUserbotDriver | undefined;
  const observerState: TelegramQaObserverState = {
    filteredCount: 0,
    matchedCount: 0,
    relevantUpdateKinds: new Set(),
    updateCount: 0,
  };
  const accountId = options.sutAccountId?.trim() || "sut";
  let logicalConversationId = credentialLease.payload.groupId;
  let logicalConversationKind: "channel" | "direct" | "group" = "channel";
  const nativeMessageIds = new Map<string, number>();
  const busMessageIds = new Map<number, string>();

  const observeUpdate = async (update: TelegramUserbotUpdate) => {
    observerState.updateCount += 1;
    observerState.relevantUpdateKinds.add(update.kind);
    if (
      update.chatId !== Number(credentialLease.payload.groupId) ||
      update.senderId !== Number(credentialLease.payload.sutBotId)
    ) {
      observerState.filteredCount += 1;
      return;
    }
    observerState.matchedCount += 1;
    const existingMessageId = busMessageIds.get(update.messageId);
    if (update.kind === "edit" && existingMessageId) {
      await context.messages.editMessage({
        accountId,
        messageId: existingMessageId,
        text: update.text,
        timestamp: update.timestamp,
      });
      return;
    }
    const outbound = await context.messages.addOutboundMessage({
      accountId,
      to: `${logicalConversationKind}:${logicalConversationId}`,
      senderId: String(update.senderId),
      senderName: update.senderUsername,
      text: update.text,
      timestamp: update.timestamp,
      replyToId: update.replyToMessageId ? busMessageIds.get(update.replyToMessageId) : undefined,
    });
    nativeMessageIds.set(outbound.id, update.messageId);
    busMessageIds.set(update.messageId, outbound.id);
  };

  try {
    stateRoot = skillRuntime.createStateRoot();
    const restored = skillRuntime.restoreCredential(credentialLease.payload, stateRoot);
    apiProxy = await skillRuntime.startApiProxy(leaseHealth);
    await apiProxy.drainUpdates(restored.sutToken);
    userbot = await TelegramUserbotDriver.start({
      chatId: restored.groupId,
      driverEnv: restored.driverEnv,
      leaseHealth,
      userDriverPath: skillRuntime.userDriverPath,
      onUpdate: observeUpdate,
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await userbot?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await apiProxy?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (stateRoot) {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
    try {
      await releaseCredentialLease();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Telegram userbot setup and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }

  if (!userbot || !apiProxy || !stateRoot) {
    throw new Error("Telegram userbot runtime did not start.");
  }
  const activeUserbot = userbot;
  const activeApiProxy = apiProxy;
  const activeStateRoot = stateRoot;
  let observerStopped = false;
  let apiProxyClosed = false;
  return {
    id: "telegram",
    label: "Telegram live",
    accountId,
    requiredPluginIds: ["telegram"],
    supportedActions: [],
    assertTransportHealthy() {
      activeUserbot.assertHealthy();
      heartbeat.throwIfFailed();
    },
    describeTransportState: () => describeTelegramQaObserverState(observerState),
    async sendInbound(input) {
      heartbeat.throwIfFailed();
      logicalConversationId = input.conversation.id;
      logicalConversationKind = input.conversation.kind;
      const text = renderTelegramQaInboundText(input, credentialLease.payload.sutUsername);
      const nativeReplyToId = input.replyToId ? nativeMessageIds.get(input.replyToId) : undefined;
      const sent = await activeUserbot.send({ text, replyToMessageId: nativeReplyToId });
      const message = await context.messages.addInboundMessage({
        ...input,
        accountId,
        senderId: credentialLease.payload.testerUserId,
      });
      nativeMessageIds.set(message.id, sent.messageId);
      busMessageIds.set(sent.messageId, message.id);
      return message;
    },
    resetTransport: () => {
      logicalConversationId = credentialLease.payload.groupId;
      logicalConversationKind = "channel";
      nativeMessageIds.clear();
      busMessageIds.clear();
      observerState.updateCount = 0;
      observerState.filteredCount = 0;
      observerState.matchedCount = 0;
      observerState.relevantUpdateKinds.clear();
    },
    createGatewayConfig: () =>
      buildTelegramQaConfig({} as OpenClawConfig, {
        apiRoot: activeApiProxy.apiRoot,
        groupId: credentialLease.payload.groupId,
        sutToken: credentialLease.payload.sutToken,
        testerUserId: credentialLease.payload.testerUserId,
        sutAccountId: accountId,
        requireMention: options.transportPolicy?.requireGroupMention === true,
      }),
    waitReady: async ({ gateway, timeoutMs, pollIntervalMs }) =>
      await waitForTelegramChannelRunning(gateway, accountId, {
        timeoutMs,
        pollMs: pollIntervalMs,
      }),
    buildAgentDelivery: () => ({
      channel: "telegram",
      to: credentialLease.payload.groupId,
      replyChannel: "telegram",
      replyTo: credentialLease.payload.groupId,
    }),
    async handleAction() {
      throw new Error("Telegram live QA adapter does not implement transport actions");
    },
    createReportNotes: () => ["Runs through the Telegram Test Server userbot adapter."],
    async cleanup() {
      if (observerStopped) {
        return;
      }
      observerStopped = true;
      try {
        await activeUserbot.close();
      } finally {
        fs.rmSync(activeStateRoot, { recursive: true, force: true });
      }
    },
    async cleanupAfterGatewayStop() {
      const cleanupErrors: unknown[] = [];
      if (!apiProxyClosed) {
        try {
          await activeApiProxy.close();
          apiProxyClosed = true;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (await shouldRetainQaGatewayCredentialLease()) {
        try {
          await credentialLease.heartbeat();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await heartbeat.stop();
        } catch (error) {
          cleanupErrors.push(error);
        }
        throw new Error(
          "retained Telegram credential lease for two hours because isolated SUT quiescence was not proven",
          cleanupErrors.length > 0 ? { cause: new AggregateError(cleanupErrors) } : undefined,
        );
      }
      try {
        await releaseCredentialLease();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length === 1) {
        throw cleanupErrors[0];
      }
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, "Telegram userbot cleanup failed");
      }
    },
  };
}
