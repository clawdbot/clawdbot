import type { Command } from "commander";
import {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";

type TelegramQaCliRuntime = typeof import("./cli.runtime.js");

const loadTelegramQaCliRuntime = createLazyCliRuntimeLoader<TelegramQaCliRuntime>(
  () => import("./cli.runtime.js"),
);

async function runQaTelegram(opts: LiveTransportQaCommandOptions) {
  const runtime = await loadTelegramQaCliRuntime();
  await runtime.runQaTelegramCommand(opts);
}

export const telegramQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "telegram",
    description: "Run the manual Telegram live QA lane against a private bot-to-bot group harness",
    outputDirHelp: "Telegram QA artifact directory",
    scenarioHelp: "Run only the named Telegram QA scenario (repeatable)",
    sutAccountHelp: "Temporary Telegram account id inside the QA gateway config",
    run: runQaTelegram,
  });

export function registerTelegramQaCli(qa: Command) {
  telegramQaCliRegistration.register(qa);
}
