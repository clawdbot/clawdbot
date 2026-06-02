#!/usr/bin/env -S node --import tsx
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Bot, type ApiClientOptions } from "grammy";
import {
  deleteMessageTelegram,
  editMessageTelegram,
  sendMessageTelegram,
} from "../../extensions/telegram/runtime-api.js";
import { resolveTelegramAccount } from "../../extensions/telegram/src/accounts.js";
import { normalizeTelegramApiRoot } from "../../extensions/telegram/src/api-root.js";
import type { TelegramThreadSpec } from "../../extensions/telegram/src/bot/helpers.js";
import {
  createTelegramDraftStream,
  type TelegramDraftStream,
} from "../../extensions/telegram/src/draft-stream.js";
import { renderTelegramHtmlText } from "../../extensions/telegram/src/format.js";
import {
  createNativeTelegramToolProgressDraft,
  type NativeTelegramToolProgressDraft,
} from "../../extensions/telegram/src/native-tool-progress-draft.js";
import { formatReasoningMessage } from "../../src/agents/embedded-agent-utils.js";
import { getRuntimeConfig } from "../../src/config/config.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { formatChannelProgressDraftText } from "../../src/plugin-sdk/channel-outbound.js";

type SupportedChannel = "telegram";
type SupportedFlow = "thinking-final" | "working-final";

export type ChannelMessageFlowArgs = {
  accountId?: string;
  channel: SupportedChannel;
  delayMs?: number;
  durationMs?: number;
  finalText?: string;
  flow: SupportedFlow;
  target: string;
  threadId?: number;
};

type TelegramSendFinalParams = {
  accountId?: string;
  cfg: OpenClawConfig;
  target: string;
  text: string;
  threadId?: number;
};

type TelegramFlowResult = {
  finalMessageId?: string;
  previewUpdates: number;
};

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

type TelegramThinkingFinalDeps = {
  createDraftStream?: (params: {
    accountId?: string;
    cfg: OpenClawConfig;
    target: string;
    threadId?: number;
  }) => TelegramDraftStream;
  createNativeToolProgressDraft?: (params: {
    accountId?: string;
    cfg: OpenClawConfig;
    target: string;
    threadId?: number;
  }) => NativeTelegramToolProgressDraft;
  sendFinal?: (params: TelegramSendFinalParams) => Promise<{ messageId?: string }>;
  sleep?: (ms: number) => Promise<void>;
};

export type TelegramThinkingFinalFlowOptions = ChannelMessageFlowArgs & {
  cfg: OpenClawConfig;
  thinkingUpdates?: readonly string[];
};

export type TelegramWorkingFinalFlowOptions = ChannelMessageFlowArgs & {
  cfg: OpenClawConfig;
};

const DEFAULT_THINKING_FINAL_UPDATES = [
  "I'll inspect the Telegram stream surface first.",
  "I found the reasoning preview path and I’m checking final delivery.",
  "The preview should clear before the durable final answer lands.",
] as const;

const DEFAULT_THINKING_FINAL_TEXT =
  "Final answer: the Telegram thinking preview cleared and this durable reply landed.";
const DEFAULT_WORKING_FINAL_TEXT =
  "Final answer: the Telegram working preview cleared and this durable reply landed.";
const DEFAULT_WORKING_PROGRESS_TIMELINE = [
  {
    atMs: 2_000,
    line: "🛠️ pgrep -fl Discord || true (agent)",
  },
  {
    atMs: 5_000,
    line: "🛠️ list files in /Applications/Discord.app -> run true (agent)",
  },
  {
    atMs: 7_000,
    line: "🛠️ sw_vers (agent)",
  },
  {
    atMs: 8_000,
    line: "Discord is installed as a normal '/Applications/Discord.app', not as a Homebrew-managed cask, and it's currently running.",
  },
  {
    atMs: 11_000,
    line: "🛠️ osascript -e 'tell application \"Discord\" to quit' || true sleep 3 pgrep -fl Discord || true (agent)",
  },
  {
    atMs: 14_000,
    line: "🛠️ brew install --cask --force discord (agent)",
  },
  {
    atMs: 17_000,
    line: "Homebrew found Discord as an outdated cask after updating its metadata, so this is doing a real cask reinstall.",
  },
] as const;

function usage(): string {
  return [
    "Usage:",
    "  node --import tsx scripts/dev/channel-message-flows.ts --channel telegram --target <chat-id> --flow <flow> [options]",
    "",
    "Flows:",
    "  thinking-final      Reasoning/Thinking preview, then a final answer",
    "  working-final       Native sendMessageDraft tool progress, then a final answer",
    "",
    "Options:",
    "  --account <accountId>   Telegram account id to use",
    "  --thread-id <id>        Telegram forum topic/message thread id",
    "  --delay-ms <ms>         Delay between preview updates (default: flow-specific)",
    "  --duration-ms <ms>      Simulated working duration for working-final (default: 12000)",
    "  --final-text <text>     Override the final durable message",
  ].join("\n");
}

function readFlagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function parseIntegerFlag(raw: string | undefined, label: string): number | undefined {
  if (raw == null) {
    return undefined;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${label} must be a non-negative integer.\n\n${usage()}`);
  }
  return Number(raw);
}

export function parseChannelMessageFlowArgs(args: readonly string[]): ChannelMessageFlowArgs {
  if (args.includes("--help") || args.includes("-h")) {
    throw new Error(usage());
  }

  const channel = readFlagValue(args, "--channel");
  const flow = readFlagValue(args, "--flow");
  const target = readFlagValue(args, "--target") ?? readFlagValue(args, "--chat");

  if (channel !== "telegram") {
    throw new Error(`Only --channel telegram is supported for now.\n\n${usage()}`);
  }
  if (flow !== "thinking-final" && flow !== "working-final") {
    throw new Error(`Unsupported --flow ${flow ?? "<missing>"}.\n\n${usage()}`);
  }
  if (!target) {
    throw new Error(`Missing --target <chat-id>.\n\n${usage()}`);
  }

  return {
    accountId: readFlagValue(args, "--account") ?? readFlagValue(args, "--account-id"),
    channel,
    delayMs: parseIntegerFlag(readFlagValue(args, "--delay-ms"), "--delay-ms"),
    durationMs: parseIntegerFlag(readFlagValue(args, "--duration-ms"), "--duration-ms"),
    finalText: readFlagValue(args, "--final-text"),
    flow,
    target,
    threadId: parseIntegerFlag(readFlagValue(args, "--thread-id"), "--thread-id"),
  };
}

function resolveWorkingProgressLines(elapsedMs: number): string[] {
  return DEFAULT_WORKING_PROGRESS_TIMELINE.filter((entry) => entry.atMs <= elapsedMs).map(
    (entry) => entry.line,
  );
}

function formatWorkingProgressPreview(elapsedMs: number): string {
  return formatChannelProgressDraftText({
    entry: { streaming: { progress: { label: "Working", toolProgress: false } } },
    lines: resolveWorkingProgressLines(elapsedMs),
  });
}

function createTelegramFlowApi(params: { accountId?: string; cfg: OpenClawConfig }): Bot["api"] {
  return {
    sendMessage: async (chatId, text, sendParams) => {
      const result = await sendMessageTelegram(String(chatId), text, {
        accountId: params.accountId,
        cfg: params.cfg,
        messageThreadId: sendParams?.message_thread_id,
        textMode: sendParams?.parse_mode === "HTML" ? "html" : "markdown",
      });
      return { message_id: Number(result.messageId) };
    },
    editMessageText: async (chatId, messageId, text, editParams) => {
      await editMessageTelegram(String(chatId), messageId, text, {
        accountId: params.accountId,
        cfg: params.cfg,
        textMode: editParams?.parse_mode === "HTML" ? "html" : "markdown",
      });
      return true;
    },
    deleteMessage: async (chatId, messageId) => {
      await deleteMessageTelegram(String(chatId), messageId, {
        accountId: params.accountId,
        cfg: params.cfg,
      });
      return true;
    },
  } as Bot["api"];
}

export function resolveTelegramFlowThreadSpec(threadId?: number): TelegramThreadSpec | undefined {
  return typeof threadId === "number" ? { id: threadId, scope: "forum" } : undefined;
}

function createDefaultTelegramDraftStream(params: {
  accountId?: string;
  cfg: OpenClawConfig;
  target: string;
  threadId?: number;
}): TelegramDraftStream {
  return createTelegramDraftStream({
    api: createTelegramFlowApi(params),
    chatId: params.target,
    minInitialChars: 0,
    renderText: (text) => ({
      parseMode: "HTML",
      text: renderTelegramHtmlText(text, { textMode: "markdown" }),
    }),
    thread: resolveTelegramFlowThreadSpec(params.threadId),
    throttleMs: 250,
  });
}

function createTelegramNativeDraftApi(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): Bot["api"] {
  const account = resolveTelegramAccount({
    accountId: params.accountId,
    cfg: params.cfg,
  });
  if (!account.enabled) {
    throw new Error(`Telegram account "${account.accountId}" is disabled.`);
  }
  if (!account.token) {
    throw new Error(`Telegram account "${account.accountId}" has no bot token.`);
  }
  const apiRoot = account.config.apiRoot?.trim();
  const client: ApiClientOptions | undefined = apiRoot
    ? { apiRoot: normalizeTelegramApiRoot(apiRoot) }
    : undefined;
  return new Bot(account.token, client ? { client } : undefined).api;
}

function createDefaultNativeToolProgressDraft(params: {
  accountId?: string;
  cfg: OpenClawConfig;
  target: string;
  threadId?: number;
}): NativeTelegramToolProgressDraft {
  const draft = createNativeTelegramToolProgressDraft({
    api: createTelegramNativeDraftApi(params),
    chatId: params.target,
    thread: resolveTelegramFlowThreadSpec(params.threadId),
  });
  if (!draft) {
    throw new Error("Telegram Bot API client does not expose sendMessageDraft.");
  }
  return draft;
}

async function sendTelegramFinal(params: TelegramSendFinalParams): Promise<{ messageId?: string }> {
  return await sendMessageTelegram(params.target, params.text, {
    accountId: params.accountId,
    cfg: params.cfg,
    messageThreadId: params.threadId,
  });
}

export async function runTelegramThinkingFinalFlow(
  options: TelegramThinkingFinalFlowOptions,
  deps: TelegramThinkingFinalDeps = {},
): Promise<TelegramFlowResult> {
  const delayMs = options.delayMs ?? 900;
  const thinkingUpdates = options.thinkingUpdates ?? DEFAULT_THINKING_FINAL_UPDATES;
  const stream = (deps.createDraftStream ?? createDefaultTelegramDraftStream)({
    accountId: options.accountId,
    cfg: options.cfg,
    target: options.target,
    threadId: options.threadId,
  });
  const wait = deps.sleep ?? sleep;

  let previewStarted = false;
  let flowError: unknown;
  try {
    for (const update of thinkingUpdates) {
      previewStarted = true;
      stream.update(formatReasoningMessage(update));
      await stream.flush();
      if (delayMs > 0) {
        await wait(delayMs);
      }
    }
  } catch (error) {
    flowError = error;
  }
  let cleanupError: unknown;
  if (previewStarted) {
    try {
      await stream.clear();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (flowError) {
    throw toError(flowError);
  }
  if (cleanupError) {
    throw toError(cleanupError);
  }

  const final = await (deps.sendFinal ?? sendTelegramFinal)({
    accountId: options.accountId,
    cfg: options.cfg,
    target: options.target,
    text: options.finalText ?? DEFAULT_THINKING_FINAL_TEXT,
    threadId: options.threadId,
  });

  return {
    finalMessageId: final.messageId,
    previewUpdates: thinkingUpdates.length,
  };
}

export async function runTelegramWorkingFinalFlow(
  options: TelegramWorkingFinalFlowOptions,
  deps: TelegramThinkingFinalDeps = {},
): Promise<TelegramFlowResult> {
  const delayMs = options.delayMs ?? 2_000;
  const durationMs = options.durationMs ?? 12_000;
  const draft = (deps.createNativeToolProgressDraft ?? createDefaultNativeToolProgressDraft)({
    accountId: options.accountId,
    cfg: options.cfg,
    target: options.target,
    threadId: options.threadId,
  });
  const wait = deps.sleep ?? sleep;

  let previewUpdates = 0;
  let lastPreviewText = "";
  const updateIntervalMs = delayMs > 0 ? delayMs : 1_000;
  let draftStarted = false;
  let flowError: unknown;
  try {
    for (let elapsedMs = 0; elapsedMs < durationMs; elapsedMs += updateIntervalMs) {
      const previewText = formatWorkingProgressPreview(elapsedMs);
      if (previewText !== lastPreviewText) {
        draftStarted = true;
        await draft.update(previewText);
        lastPreviewText = previewText;
        previewUpdates += 1;
      }
      if (delayMs > 0 && elapsedMs + updateIntervalMs < durationMs) {
        await wait(delayMs);
      }
    }
  } catch (error) {
    flowError = error;
  }
  let cleanupError: unknown;
  if (draftStarted) {
    try {
      draft.stop();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (flowError) {
    throw toError(flowError);
  }
  if (cleanupError) {
    throw toError(cleanupError);
  }

  const final = await (deps.sendFinal ?? sendTelegramFinal)({
    accountId: options.accountId,
    cfg: options.cfg,
    target: options.target,
    text: options.finalText ?? DEFAULT_WORKING_FINAL_TEXT,
    threadId: options.threadId,
  });

  return {
    finalMessageId: final.messageId,
    previewUpdates,
  };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const parsed = parseChannelMessageFlowArgs(args);
  const cfg = getRuntimeConfig();
  const result =
    parsed.flow === "working-final"
      ? await runTelegramWorkingFinalFlow({ ...parsed, cfg })
      : await runTelegramThinkingFinalFlow({ ...parsed, cfg });

  process.stdout.write(
    `Sent ${parsed.channel}/${parsed.flow} to ${parsed.target} (${result.previewUpdates} preview updates, final message ${result.finalMessageId ?? "unknown"}).\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
