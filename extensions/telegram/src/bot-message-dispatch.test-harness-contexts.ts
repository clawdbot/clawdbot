import type { Bot } from "grammy";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  createBot,
  createContext,
  createRuntime,
  dispatchTelegramMessage,
  loadSessionStore,
  telegramDepsForTest,
  type TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";

export async function dispatchWithContext(params: {
  context: TelegramMessageContext;
  cfg?: Parameters<typeof dispatchTelegramMessage>[0]["cfg"];
  telegramCfg?: Parameters<typeof dispatchTelegramMessage>[0]["telegramCfg"];
  streamMode?: Parameters<typeof dispatchTelegramMessage>[0]["streamMode"];
  telegramDeps?: TelegramBotDeps;
  bot?: Bot;
  replyToMode?: Parameters<typeof dispatchTelegramMessage>[0]["replyToMode"];
  retryDispatchErrors?: boolean;
  suppressFailureFallback?: boolean;
  textLimit?: number;
  turnAdoptionLifecycle?: Parameters<typeof dispatchTelegramMessage>[0]["turnAdoptionLifecycle"];
  runtime?: Parameters<typeof dispatchTelegramMessage>[0]["runtime"];
  opts?: Parameters<typeof dispatchTelegramMessage>[0]["opts"];
}) {
  const bot = params.bot ?? createBot();
  return await dispatchTelegramMessage({
    context: params.context,
    bot,
    cfg: params.cfg ?? {},
    runtime: params.runtime ?? createRuntime(),
    replyToMode: params.replyToMode ?? "first",
    streamMode: params.streamMode ?? "partial",
    textLimit: params.textLimit ?? 4096,
    telegramCfg: params.telegramCfg ?? {},
    telegramDeps: params.telegramDeps ?? telegramDepsForTest,
    opts: params.opts ?? { token: "token" },
    retryDispatchErrors: params.retryDispatchErrors,
    suppressFailureFallback: params.suppressFailureFallback,
    turnAdoptionLifecycle: params.turnAdoptionLifecycle,
  });
}

export function createReasoningStreamContext(): TelegramMessageContext {
  loadSessionStore.mockReturnValue({
    s1: { reasoningLevel: "stream" },
  });
  return createContext({
    ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
  });
}

export function createReasoningDefaultContext(): TelegramMessageContext {
  loadSessionStore.mockReturnValue({
    s1: {},
  });
  return createContext({
    ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
    route: { agentId: "ops" } as unknown as TelegramMessageContext["route"],
  });
}

export function createReasoningForumTopicContext(): TelegramMessageContext {
  loadSessionStore.mockReturnValue({
    s1: { reasoningLevel: "stream" },
  });
  return createContext({
    ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
    msg: {
      chat: { id: -100123, type: "supergroup", is_forum: true },
      message_id: 456,
      message_thread_id: 88,
    } as unknown as TelegramMessageContext["msg"],
    chatId: -100123,
    isGroup: true,
    threadSpec: { id: 88, scope: "forum" },
  });
}
