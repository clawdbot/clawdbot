// Test Device Pair Telegram script supports OpenClaw repository automation.
import { pathToFileURL } from "node:url";
import { getRuntimeConfig } from "../../src/config/config.js";
import { matchPluginCommand, executePluginCommand } from "../../src/plugins/commands.js";
import { loadOpenClawPlugins } from "../../src/plugins/loader.js";

type SendMessageTelegram = (
  chatId: string,
  text: string,
  options: {
    accountId?: string;
    cfg?: ReturnType<typeof getRuntimeConfig>;
  },
) => Promise<{ chatId?: string; messageId?: string }>;

type DevicePairTelegramDeps = {
  executePluginCommand: typeof executePluginCommand;
  getRuntimeConfig: typeof getRuntimeConfig;
  loadOpenClawPlugins: typeof loadOpenClawPlugins;
  matchPluginCommand: typeof matchPluginCommand;
  sendMessageTelegram: SendMessageTelegram;
};

type DevicePairTelegramResult = {
  accountId?: string;
  chatId: string;
  messageId?: string;
  sent: boolean;
};

class UsageError extends Error {
  readonly exitCode = 1;
}

function writeStdoutLine(...parts: string[]): void {
  process.stdout.write(`${parts.join(" ")}\n`);
}

function writeStderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

function readArg(args: string[], flag: string, short?: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  if (short) {
    const sidx = args.indexOf(short);
    if (sidx !== -1 && sidx + 1 < args.length) {
      return args[sidx + 1];
    }
  }
  return undefined;
}

function usage(): string {
  return [
    "Usage: bun scripts/dev/test-device-pair-telegram.ts --chat <telegram-chat-id> [--account <accountId>]",
  ].join("\n");
}

async function loadTelegramRuntimeSendMessage(): Promise<SendMessageTelegram> {
  const specifier = "../../extensions/telegram/runtime-api.js";
  const runtime = (await import(specifier)) as { sendMessageTelegram?: SendMessageTelegram };
  if (typeof runtime.sendMessageTelegram !== "function") {
    throw new Error("Telegram runtime-api.js did not export sendMessageTelegram");
  }
  return runtime.sendMessageTelegram;
}

function createDefaultDeps(): DevicePairTelegramDeps {
  return {
    executePluginCommand,
    getRuntimeConfig,
    loadOpenClawPlugins,
    matchPluginCommand,
    sendMessageTelegram: async (...args) => {
      const sendMessageTelegram = await loadTelegramRuntimeSendMessage();
      return await sendMessageTelegram(...args);
    },
  };
}

async function runDevicePairTelegram(
  args = process.argv.slice(2),
  deps: DevicePairTelegramDeps = createDefaultDeps(),
): Promise<DevicePairTelegramResult> {
  const chatId = readArg(args, "--chat", "-c");
  const accountId = readArg(args, "--account", "-a");
  if (!chatId) {
    throw new UsageError(usage());
  }

  const cfg = deps.getRuntimeConfig();
  deps.loadOpenClawPlugins({ config: cfg });

  const match = deps.matchPluginCommand("/pair", { channel: "telegram" });
  if (!match) {
    throw new Error("/pair plugin command not registered.");
  }

  const result = await deps.executePluginCommand({
    command: match.command,
    args: match.args,
    senderId: chatId,
    channel: "telegram",
    channelId: "telegram",
    isAuthorizedSender: true,
    commandBody: "/pair",
    config: cfg,
    from: `telegram:${chatId}`,
    to: `telegram:${chatId}`,
    accountId,
  });

  if (!result.text) {
    return { accountId, chatId, sent: false };
  }

  const sent = await deps.sendMessageTelegram(chatId, result.text, {
    accountId,
    cfg,
  });

  return {
    accountId,
    chatId: sent.chatId ?? chatId,
    messageId: sent.messageId,
    sent: true,
  };
}

async function main(): Promise<void> {
  try {
    const result = await runDevicePairTelegram();
    writeStdoutLine(
      "Sent split /pair messages to",
      result.chatId,
      result.accountId ? `(${result.accountId})` : "",
      result.messageId ? `message=${result.messageId}` : "",
    );
  } catch (error) {
    writeStderrLine(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof UsageError ? error.exitCode : 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

export { runDevicePairTelegram };
