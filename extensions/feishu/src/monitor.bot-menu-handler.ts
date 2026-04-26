import type { ClawdbotConfig, HistoryEntry, RuntimeEnv } from "../runtime-api.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import { maybeHandleFeishuQuickActionMenu } from "./card-ux-launcher.js";
import {
  claimUnprocessedFeishuMessage,
  recordProcessedFeishuMessage,
  releaseFeishuMessageProcessing,
} from "./dedup.js";
import { botNames, botOpenIds } from "./monitor.state.js";
import { isFeishuRetryableSyntheticEventError } from "./monitor.synthetic-error.js";

type FeishuBotMenuEvent = {
  event_key?: string;
  timestamp?: string | number;
  operator?: {
    operator_name?: string;
    operator_id?: { open_id?: string; user_id?: string; union_id?: string };
  };
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringOrNumber(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFeishuBotMenuEvent(value: unknown): FeishuBotMenuEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const operator = value.operator;
  if (operator !== undefined && !isRecord(operator)) {
    return null;
  }
  return {
    event_key: readString(value.event_key),
    timestamp: readStringOrNumber(value.timestamp),
    operator: operator
      ? {
          operator_name: readString(operator.operator_name),
          operator_id: isRecord(operator.operator_id)
            ? {
                open_id: readString(operator.operator_id.open_id),
                user_id: readString(operator.operator_id.user_id),
                union_id: readString(operator.operator_id.union_id),
              }
            : undefined,
        }
      : undefined,
  };
}

export function createFeishuBotMenuHandler(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  fireAndForget?: boolean;
  getBotOpenId?: (accountId: string) => string | undefined;
  getBotName?: (accountId: string) => string | undefined;
}): (data: unknown) => Promise<void> {
  const { cfg, accountId, runtime, chatHistories, fireAndForget } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const getBotOpenId = params.getBotOpenId ?? ((id) => botOpenIds.get(id));
  const getBotName = params.getBotName ?? ((id) => botNames.get(id));

  return async (data) => {
    try {
      const event = parseFeishuBotMenuEvent(data);
      if (!event) {
        return;
      }
      const operatorOpenId = event.operator?.operator_id?.open_id?.trim();
      const eventKey = event.event_key?.trim();
      if (!operatorOpenId || !eventKey) {
        return;
      }
      const syntheticEvent: FeishuMessageEvent = {
        sender: {
          sender_id: {
            open_id: operatorOpenId,
            user_id: event.operator?.operator_id?.user_id,
            union_id: event.operator?.operator_id?.union_id,
          },
          sender_type: "user",
        },
        message: {
          message_id: `bot-menu:${eventKey}:${event.timestamp ?? Date.now()}`,
          suppress_reply_target: true,
          chat_id: `p2p:${operatorOpenId}`,
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({
            text: `/menu ${eventKey}`,
          }),
        },
      };
      const syntheticMessageId = syntheticEvent.message.message_id;
      const claim = await claimUnprocessedFeishuMessage({
        messageId: syntheticMessageId,
        namespace: accountId,
        log,
      });
      if (claim === "duplicate") {
        log(`feishu[${accountId}]: dropping duplicate bot-menu event for ${syntheticMessageId}`);
        return;
      }
      if (claim === "inflight") {
        log(`feishu[${accountId}]: dropping in-flight bot-menu event for ${syntheticMessageId}`);
        return;
      }
      const handleLegacyMenu = () =>
        handleFeishuMessage({
          cfg,
          event: syntheticEvent,
          botOpenId: getBotOpenId(accountId),
          botName: getBotName(accountId),
          runtime,
          chatHistories,
          accountId,
          processingClaimHeld: true,
        });

      const promise = maybeHandleFeishuQuickActionMenu({
        cfg,
        eventKey,
        operatorOpenId,
        runtime,
        accountId,
      })
        .then(async (handledMenu) => {
          if (handledMenu) {
            await recordProcessedFeishuMessage(syntheticMessageId, accountId, log);
            releaseFeishuMessageProcessing(syntheticMessageId, accountId);
            return;
          }
          return await handleLegacyMenu();
        })
        .catch(async (err) => {
          if (isFeishuRetryableSyntheticEventError(err)) {
            releaseFeishuMessageProcessing(syntheticMessageId, accountId);
          } else {
            await recordProcessedFeishuMessage(syntheticMessageId, accountId, log);
          }
          throw err;
        });
      if (fireAndForget) {
        promise.catch((err) => {
          error(`feishu[${accountId}]: error handling bot menu event: ${String(err)}`);
        });
        return;
      }
      await promise;
    } catch (err) {
      error(`feishu[${accountId}]: error handling bot menu event: ${String(err)}`);
    }
  };
}
