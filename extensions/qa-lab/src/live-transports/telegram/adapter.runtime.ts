// Qa Lab plugin module implements Telegram live transport adapter behavior.
import type { TelegramBotUpdate } from "@openclaw/telegram/api.js";
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
import { __testing as telegramLive } from "./telegram-live.runtime.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;
type TelegramRuntimeEnv = ReturnType<typeof telegramLive.resolveTelegramQaRuntimeEnv>;

export async function createTelegramQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const options = context.adapterOptions ?? {};
  const credentialLease = await acquireQaCredentialLease<TelegramRuntimeEnv>({
    kind: "telegram",
    source: options.credentialSource,
    role: options.credentialRole,
    resolveEnvPayload: () => telegramLive.resolveTelegramQaRuntimeEnv(),
    parsePayload: telegramLive.parseTelegramQaCredentialPayload,
  });
  try {
    assertQaGatewayCredentialLeaseQuarantine(credentialLease);
  } catch (error) {
    await credentialLease.release();
    throw error;
  }
  const heartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
  const runtimeEnv = credentialLease.payload;
  let driverIdentity: { id: number; username?: string };
  let sutIdentity: { id: number; username?: string };
  let offset: number;
  try {
    [driverIdentity, sutIdentity, offset] = await Promise.all([
      telegramLive.callTelegramApi<{ id: number; username?: string }>(
        runtimeEnv.driverToken,
        "getMe",
      ),
      telegramLive.callTelegramApi<{ id: number; username?: string }>(runtimeEnv.sutToken, "getMe"),
      telegramLive.flushTelegramUpdates(runtimeEnv.driverToken),
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
      const updates = await telegramLive.callTelegramApi<TelegramBotUpdate[]>(
        runtimeEnv.driverToken,
        "getUpdates",
        { offset, timeout: 1, allowed_updates: ["message", "edited_message"] },
        6_000,
      );
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        const message = update.edited_message ?? update.message;
        if (!message?.from?.id || message.from.id !== sutIdentity.id) {
          continue;
        }
        const existingMessageId = busMessageIds.get(message.message_id);
        if (update.edited_message && existingMessageId) {
          await context.messages.editMessage({
            accountId: options.sutAccountId?.trim() || "sut",
            messageId: existingMessageId,
            text: message.text ?? message.caption ?? "",
          });
          continue;
        }
        const outbound = await context.messages.addOutboundMessage({
          accountId: options.sutAccountId?.trim() || "sut",
          to: `${logicalConversationKind}:${logicalConversationId}`,
          senderId: String(message.from.id),
          senderName: message.from.username,
          text: message.text ?? message.caption ?? "",
          timestamp: message.date * 1_000,
          replyToId: message.reply_to_message?.message_id
            ? busMessageIds.get(message.reply_to_message.message_id)
            : undefined,
        });
        busMessageIds.set(message.message_id, outbound.id);
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
      const sent = await telegramLive.callTelegramApi<{ message_id: number }>(
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
      telegramLive.buildTelegramQaConfig({} as OpenClawConfig, {
        groupId: runtimeEnv.groupId,
        sutToken: runtimeEnv.sutToken,
        driverBotId: driverIdentity.id,
        sutAccountId: accountId,
      }),
    waitReady: async ({ gateway, timeoutMs, pollIntervalMs }) =>
      await telegramLive.waitForTelegramChannelRunning(gateway as never, accountId, {
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
