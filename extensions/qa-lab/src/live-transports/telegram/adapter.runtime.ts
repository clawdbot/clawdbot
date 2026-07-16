// Qa Lab plugin module implements Telegram live transport adapter behavior.
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
import {
  buildTelegramQaConfig,
  callTelegramApi,
  flushTelegramUpdates,
  isRecoverableTelegramQaPollError,
  normalizeTelegramObservedMessage,
  parseTelegramQaCredentialPayload,
  resolveTelegramQaRuntimeEnv,
  waitForTelegramChannelRunning,
  waitForTelegramPollRetryDelay,
  type TelegramBotIdentity,
  type TelegramQaRuntimeEnv,
  type TelegramUpdate,
} from "./telegram-api.runtime.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;
export async function createTelegramQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const options = context.adapterOptions ?? {};
  const credentialLease = await acquireQaCredentialLease<TelegramQaRuntimeEnv>({
    kind: "telegram",
    source: options.credentialSource,
    role: options.credentialRole,
    resolveEnvPayload: () => resolveTelegramQaRuntimeEnv(),
    parsePayload: parseTelegramQaCredentialPayload,
  });
  try {
    assertQaGatewayCredentialLeaseQuarantine(credentialLease);
  } catch (error) {
    await credentialLease.release();
    throw error;
  }
  const heartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
  const runtimeEnv = credentialLease.payload;
  let driverIdentity: TelegramBotIdentity;
  let sutIdentity: TelegramBotIdentity;
  let offset: number;
  try {
    [driverIdentity, sutIdentity] = await Promise.all([
      callTelegramApi<TelegramBotIdentity>(runtimeEnv.driverToken, "getMe"),
      callTelegramApi<TelegramBotIdentity>(runtimeEnv.sutToken, "getMe"),
    ]);
    if (!driverIdentity.is_bot || !sutIdentity.is_bot) {
      throw new Error("Telegram QA credentials must belong to bots.");
    }
    if (driverIdentity.id === sutIdentity.id) {
      throw new Error("Telegram QA requires two distinct bots for driver and SUT.");
    }
    if (!sutIdentity.username?.trim()) {
      throw new Error("Telegram QA requires the SUT bot to have a Telegram username.");
    }
    [offset] = await Promise.all([
      flushTelegramUpdates(runtimeEnv.driverToken),
      flushTelegramUpdates(runtimeEnv.sutToken),
    ]);
  } catch (error) {
    await heartbeat.stop();
    await credentialLease.release();
    throw error;
  }
  let stopped = false;
  let pollingError: Error | undefined;
  let logicalConversationId = runtimeEnv.groupId;
  let logicalConversationKind: "channel" | "direct" | "group" = "channel";
  const nativeMessageIds = new Map<string, number>();
  const busMessageIds = new Map<number, string>();
  const poll = async () => {
    for (;;) {
      if (stopped) {
        return;
      }
      let updates: TelegramUpdate[];
      try {
        updates = await callTelegramApi<TelegramUpdate[]>(
          runtimeEnv.driverToken,
          "getUpdates",
          { offset, timeout: 1, allowed_updates: ["message", "edited_message"] },
          6_000,
        );
      } catch (error) {
        if (!isRecoverableTelegramQaPollError(error)) {
          throw error;
        }
        await waitForTelegramPollRetryDelay();
        continue;
      }
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        const message = normalizeTelegramObservedMessage(update);
        if (
          !message ||
          message.chatId !== Number(runtimeEnv.groupId) ||
          message.senderId !== sutIdentity.id
        ) {
          continue;
        }
        const existingMessageId = busMessageIds.get(message.messageId);
        if (update.edited_message) {
          if (existingMessageId) {
            await context.messages.editMessage({
              accountId: options.sutAccountId?.trim() || "sut",
              messageId: existingMessageId,
              text: message.text,
              timestamp: message.timestamp,
            });
          }
          continue;
        }
        const outbound = await context.messages.addOutboundMessage({
          accountId: options.sutAccountId?.trim() || "sut",
          to: `${logicalConversationKind}:${logicalConversationId}`,
          senderId: String(message.senderId),
          senderName: message.senderUsername,
          text: message.text,
          timestamp: message.timestamp,
          replyToId: message.replyToMessageId
            ? busMessageIds.get(message.replyToMessageId)
            : undefined,
        });
        nativeMessageIds.set(outbound.id, message.messageId);
        busMessageIds.set(message.messageId, outbound.id);
      }
    }
  };
  const polling = poll().catch((error: unknown) => {
    if (!stopped) {
      pollingError = error instanceof Error ? error : new Error(String(error));
    }
  });
  const accountId = options.sutAccountId?.trim() || "sut";

  return {
    id: "telegram",
    label: "Telegram live",
    accountId,
    requiredPluginIds: ["telegram"],
    supportedActions: [],
    assertTransportHealthy() {
      if (pollingError) {
        throw pollingError;
      }
      heartbeat.throwIfFailed();
    },
    async sendInbound(input) {
      heartbeat.throwIfFailed();
      logicalConversationId = input.conversation.id;
      logicalConversationKind = input.conversation.kind;
      const text = sutIdentity.username
        ? input.text.replaceAll("@openclaw", `@${sutIdentity.username}`)
        : input.text;
      const nativeReplyToId = input.replyToId ? nativeMessageIds.get(input.replyToId) : undefined;
      const sent = await callTelegramApi<{ message_id: number }>(
        runtimeEnv.driverToken,
        "sendMessage",
        {
          chat_id: runtimeEnv.groupId,
          text,
          disable_notification: true,
          ...(nativeReplyToId
            ? {
                reply_parameters: {
                  message_id: nativeReplyToId,
                  allow_sending_without_reply: true,
                },
              }
            : {}),
        },
      );
      const message = await context.messages.addInboundMessage({
        ...input,
        accountId,
        senderId: String(driverIdentity.id),
        senderName: driverIdentity.username,
      });
      nativeMessageIds.set(message.id, sent.message_id);
      busMessageIds.set(sent.message_id, message.id);
      return message;
    },
    resetTransport: () => {
      logicalConversationId = runtimeEnv.groupId;
      logicalConversationKind = "channel";
      nativeMessageIds.clear();
      busMessageIds.clear();
    },
    createGatewayConfig: () =>
      buildTelegramQaConfig({} as OpenClawConfig, {
        groupId: runtimeEnv.groupId,
        sutToken: runtimeEnv.sutToken,
        driverBotId: driverIdentity.id,
        sutAccountId: accountId,
      }),
    waitReady: async ({ gateway, timeoutMs, pollIntervalMs }) =>
      await waitForTelegramChannelRunning(gateway, accountId, {
        timeoutMs,
        pollMs: pollIntervalMs,
      }),
    buildAgentDelivery: () => ({
      channel: "telegram",
      to: runtimeEnv.groupId,
      replyChannel: "telegram",
      replyTo: runtimeEnv.groupId,
    }),
    async handleAction() {
      throw new Error("Telegram live QA adapter does not implement transport actions");
    },
    createReportNotes: () => ["Runs through the Telegram live adapter and shared QA suite host."],
    async cleanup() {
      stopped = true;
      await polling.catch(() => undefined);
      if (await shouldRetainQaGatewayCredentialLease()) {
        const quarantineErrors: unknown[] = [];
        try {
          await credentialLease.heartbeat();
        } catch (error) {
          quarantineErrors.push(error);
        }
        try {
          await heartbeat.stop();
        } catch (error) {
          quarantineErrors.push(error);
        }
        throw new Error(
          "retained Telegram credential lease for two hours because isolated SUT quiescence was not proven",
          quarantineErrors.length > 0 ? { cause: new AggregateError(quarantineErrors) } : undefined,
        );
      }
      await heartbeat.stop();
      await credentialLease.release();
    },
  };
}
