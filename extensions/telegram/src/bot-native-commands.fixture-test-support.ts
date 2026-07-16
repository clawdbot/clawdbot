import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { vi } from "vitest";
import type { OpenClawConfig, TelegramAccountConfig } from "../runtime-api.js";
import type { RegisterTelegramNativeCommandsParams } from "./bot-native-commands.js";

export type NativeCommandTestParams = RegisterTelegramNativeCommandsParams;

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export function createNativeCommandTestParams(
  params: Partial<NativeCommandTestParams> = {},
): NativeCommandTestParams {
  const log = vi.fn();
  return {
    bot:
      params.bot ??
      ({
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as NativeCommandTestParams["bot"]),
    cfg: params.cfg ?? ({} as OpenClawConfig),
    runtime:
      params.runtime ??
      ({
        log,
        error: vi.fn(),
        exit: vi.fn(),
      } as unknown as RuntimeEnv),
    accountId: params.accountId ?? "default",
    telegramCfg: params.telegramCfg ?? ({} as TelegramAccountConfig),
    allowFrom: params.allowFrom ?? [],
    groupAllowFrom: params.groupAllowFrom ?? [],
    replyToMode: params.replyToMode ?? "off",
    textLimit: params.textLimit ?? 4000,
    useAccessGroups: params.useAccessGroups ?? false,
    nativeEnabled: params.nativeEnabled ?? true,
    nativeSkillsEnabled: params.nativeSkillsEnabled ?? false,
    nativeDisabledExplicit: params.nativeDisabledExplicit ?? false,
    resolveGroupPolicy:
      params.resolveGroupPolicy ??
      (() =>
        ({
          allowlistEnabled: false,
          allowed: true,
        }) as ReturnType<NativeCommandTestParams["resolveGroupPolicy"]>),
    resolveTelegramGroupConfig:
      params.resolveTelegramGroupConfig ??
      ((_chatId, _messageThreadId) => ({ groupConfig: undefined, topicConfig: undefined })),
    shouldSkipUpdate: params.shouldSkipUpdate ?? (() => false),
    telegramDeps: params.telegramDeps,
    opts: params.opts ?? { token: "token" },
  };
}

export function createTelegramPrivateCommandContext(params?: {
  match?: string;
  messageId?: number;
  date?: number;
  chatId?: number;
  userId?: number;
  username?: string;
}) {
  return {
    match: params?.match ?? "",
    message: {
      message_id: params?.messageId ?? 1,
      date: params?.date ?? Math.floor(Date.now() / 1000),
      chat: { id: params?.chatId ?? 100, type: "private" as const },
      from: { id: params?.userId ?? 200, username: params?.username ?? "bob" },
    },
  };
}

export function createTelegramTopicCommandContext(params?: {
  match?: string;
  messageId?: number;
  date?: number;
  chatId?: number;
  title?: string;
  threadId?: number;
  userId?: number;
  username?: string;
}) {
  return {
    match: params?.match ?? "",
    message: {
      message_id: params?.messageId ?? 2,
      date: params?.date ?? Math.floor(Date.now() / 1000),
      chat: {
        id: params?.chatId ?? -1001234567890,
        type: "supergroup" as const,
        title: params?.title ?? "OpenClaw",
        is_forum: true,
      },
      message_thread_id: params?.threadId ?? 42,
      from: { id: params?.userId ?? 200, username: params?.username ?? "bob" },
    },
  };
}
