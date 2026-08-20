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
  TelegramQaApiError,
  waitForTelegramChannelRunning,
  waitForTelegramPollRetryDelay,
  type TelegramBotIdentity,
  type TelegramQaRuntimeEnv,
  type TelegramUpdate,
} from "./telegram-api.runtime.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;

const TELEGRAM_QA_DIAGNOSTIC_COUNT_LIMIT = 9_999;
type TelegramQaObserverState = {
  filteredCount: number;
  matchedCount: number;
  pollCount: number;
  relevantUpdateKinds: Set<"edited_message" | "message" | "other">;
  terminalError?: Error;
  updateCount: number;
};

function renderTelegramQaDiagnosticCount(value: number) {
  return value > TELEGRAM_QA_DIAGNOSTIC_COUNT_LIMIT
    ? `${TELEGRAM_QA_DIAGNOSTIC_COUNT_LIMIT}+`
    : String(value);
}

function describeTelegramQaTerminalError(error: Error | undefined) {
  if (!error) {
    return "none";
  }
  if (error instanceof TelegramQaApiError) {
    return `{name=TelegramQaApiError,method=${error.method},error_code=${error.error_code},status=${error.status}}`;
  }
  return `{name=${error.name === "Error" ? "Error" : "unknown"}}`;
}

function describeTelegramQaObserverState(state: TelegramQaObserverState) {
  const updateKinds =
    state.relevantUpdateKinds.size > 0 ? [...state.relevantUpdateKinds] : ["none"];
  return [
    `telegram observer polls=${renderTelegramQaDiagnosticCount(state.pollCount)}`,
    `updates=${renderTelegramQaDiagnosticCount(state.updateCount)}`,
    `filtered=${renderTelegramQaDiagnosticCount(state.filteredCount)}`,
    `matched=${renderTelegramQaDiagnosticCount(state.matchedCount)}`,
    `update kinds=[${updateKinds.join(",")}]`,
    `terminal error=${describeTelegramQaTerminalError(state.terminalError)}`,
  ].join("; ");
}

function renderTelegramQaInboundText(
  input: { text: string; nativeCommand?: { name: string } },
  botUsername: string,
) {
  const commandName = input.nativeCommand?.name.trim().toLowerCase();
  const renderedText = input.text.replaceAll("@openclaw", `@${botUsername}`);
  const commandToken = renderedText.match(/^\S+/u)?.[0];
  // Scenarios declare command semantics once; the live adapter owns Telegram's
  // bot-username targeting while local drivers may encode the same metadata differently.
  return commandName && commandToken?.toLowerCase() === `/${commandName}`
    ? `/${commandName}@${botUsername}${renderedText.slice(commandToken.length)}`
    : renderedText;
}

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
  const releaseCredentialLease = async () => {
    // Lease release must still run when heartbeat shutdown reports an error.
    try {
      await heartbeat.stop();
    } finally {
      await credentialLease.release();
    }
  };
  const runtimeEnv = credentialLease.payload;
  let driverIdentity: TelegramBotIdentity;
  let sutIdentity: TelegramBotIdentity;
  let sutUsername: string;
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
    sutUsername = sutIdentity.username.trim();
    [offset] = await Promise.all([
      flushTelegramUpdates(runtimeEnv.driverToken),
      flushTelegramUpdates(runtimeEnv.sutToken),
    ]);
  } catch (error) {
    await releaseCredentialLease();
    throw error;
  }
  const accountId = options.sutAccountId?.trim() || "sut";
  let stopped = false;
  const observerState: TelegramQaObserverState = {
    filteredCount: 0,
    matchedCount: 0,
    pollCount: 0,
    relevantUpdateKinds: new Set(),
    updateCount: 0,
  };
  let logicalConversationId = runtimeEnv.groupId;
  let logicalConversationKind: "channel" | "direct" | "group" = "channel";
  const nativeMessageIds = new Map<string, number>();
  const busMessageIds = new Map<number, string>();
  const pollingAbort = new AbortController();
  const poll = async () => {
    let retryAttempt = 0;
    for (;;) {
      if (stopped) {
        return;
      }
      let updates: TelegramUpdate[];
      try {
        observerState.pollCount += 1;
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
        retryAttempt += 1;
        await waitForTelegramPollRetryDelay(error, retryAttempt, pollingAbort.signal);
        continue;
      }
      retryAttempt = 0;
      observerState.updateCount += updates.length;
      for (const update of updates) {
        observerState.relevantUpdateKinds.add(
          update.edited_message ? "edited_message" : update.message ? "message" : "other",
        );
        offset = Math.max(offset, update.update_id + 1);
        const message = normalizeTelegramObservedMessage(update);
        if (
          !message ||
          message.chatId !== Number(runtimeEnv.groupId) ||
          message.senderId !== sutIdentity.id
        ) {
          observerState.filteredCount += 1;
          continue;
        }
        observerState.matchedCount += 1;
        const existingMessageId = busMessageIds.get(message.messageId);
        if (update.edited_message && existingMessageId) {
          await context.messages.editMessage({
            accountId,
            messageId: existingMessageId,
            text: message.text,
            timestamp: message.timestamp,
          });
          continue;
        }
        // Telegram may expose only the final edit after the adapter resets between
        // scenarios. Adopt that edit so the live observation cannot disappear.
        const outbound = await context.messages.addOutboundMessage({
          accountId,
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
      observerState.terminalError = error instanceof Error ? error : new Error("unknown error");
    }
  });
  return {
    id: "telegram",
    label: "Telegram live",
    accountId,
    requiredPluginIds: ["telegram"],
    supportedActions: [],
    assertTransportHealthy() {
      if (observerState.terminalError) {
        throw observerState.terminalError;
      }
      heartbeat.throwIfFailed();
    },
    describeTransportState: () => describeTelegramQaObserverState(observerState),
    async sendInbound(input) {
      heartbeat.throwIfFailed();
      logicalConversationId = input.conversation.id;
      logicalConversationKind = input.conversation.kind;
      const text = renderTelegramQaInboundText(input, sutUsername);
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
      observerState.pollCount = 0;
      observerState.updateCount = 0;
      observerState.filteredCount = 0;
      observerState.matchedCount = 0;
      observerState.relevantUpdateKinds.clear();
    },
    createGatewayConfig: () =>
      buildTelegramQaConfig({} as OpenClawConfig, {
        groupId: runtimeEnv.groupId,
        sutToken: runtimeEnv.sutToken,
        driverBotId: driverIdentity.id,
        sutAccountId: accountId,
        // Mention-gating scenarios opt in through the shared transport policy.
        requireMention: options.transportPolicy?.requireGroupMention === true,
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
      pollingAbort.abort(new Error("Telegram QA observer stopped"));
      await polling.catch(() => undefined);
    },
    async cleanupAfterGatewayStop() {
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
      await releaseCredentialLease();
    },
  };
}
