// Telegram plugin module implements native tool progress draft behavior.
import type { Bot } from "grammy";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";

const TELEGRAM_NATIVE_DRAFT_MAX_CHARS = 4096;
const TELEGRAM_DRAFT_ID_STATE_KEY = Symbol.for("openclaw.telegramNativeDraftIdState");

type TelegramSendMessageDraft = (
  chatId: Parameters<Bot["api"]["sendMessage"]>[0],
  draftId: number,
  text: string,
  params?: {
    message_thread_id?: number;
    parse_mode?: "HTML";
    entities?: unknown[];
  },
) => Promise<unknown>;

export type NativeTelegramToolProgressDraft = {
  update: (text: string) => Promise<boolean>;
  stop: () => void;
};

function resolveSendMessageDraftApi(api: Bot["api"]): TelegramSendMessageDraft | undefined {
  const sendMessageDraft = (api as Bot["api"] & { sendMessageDraft?: TelegramSendMessageDraft })
    .sendMessageDraft;
  if (typeof sendMessageDraft !== "function") {
    return undefined;
  }
  return sendMessageDraft.bind(api as object);
}

function allocateTelegramDraftId(): number {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const state =
    (globalStore[TELEGRAM_DRAFT_ID_STATE_KEY] as { nextDraftId?: number } | undefined) ?? {};
  const nextDraftId = Math.trunc(state.nextDraftId ?? 0) + 1;
  state.nextDraftId = nextDraftId;
  globalStore[TELEGRAM_DRAFT_ID_STATE_KEY] = state;
  return nextDraftId;
}

function normalizeDraftText(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length > TELEGRAM_NATIVE_DRAFT_MAX_CHARS
    ? trimmed.slice(0, TELEGRAM_NATIVE_DRAFT_MAX_CHARS)
    : trimmed;
}

export function createNativeTelegramToolProgressDraft(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  thread?: TelegramThreadSpec | null;
  log?: (message: string) => void;
}): NativeTelegramToolProgressDraft | undefined {
  const sendMessageDraft = resolveSendMessageDraftApi(params.api);
  if (!sendMessageDraft) {
    return undefined;
  }

  const draftId = allocateTelegramDraftId();
  const threadParams = buildTelegramThreadParams(params.thread) ?? {};
  let stopped = false;
  let lastSentText: string | undefined;

  return {
    update: async (text: string): Promise<boolean> => {
      if (stopped) {
        return false;
      }
      const normalizedText = normalizeDraftText(text);
      if (!normalizedText) {
        return false;
      }
      if (normalizedText === lastSentText) {
        return true;
      }
      try {
        await sendMessageDraft(
          params.chatId,
          draftId,
          normalizedText,
          Object.keys(threadParams).length > 0 ? threadParams : undefined,
        );
        lastSentText = normalizedText;
        return true;
      } catch (err) {
        stopped = true;
        params.log?.(`telegram native tool-progress draft disabled: ${formatErrorMessage(err)}`);
        return false;
      }
    },
    stop: () => {
      stopped = true;
    },
  };
}
