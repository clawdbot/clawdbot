// Qa Lab plugin module implements cli behavior.
import {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";
import { TELEGRAM_QA_ALL_SCENARIO_IDS } from "./profiles.js";

type TelegramQaAdapterRuntime = typeof import("./adapter.runtime.js");
type TelegramQaCliRuntime = typeof import("./cli.runtime.js");

const loadTelegramQaAdapterRuntime = createLazyCliRuntimeLoader<TelegramQaAdapterRuntime>(
  () => import("./adapter.runtime.js"),
);
const loadTelegramQaCliRuntime = createLazyCliRuntimeLoader<TelegramQaCliRuntime>(
  () => import("./cli.runtime.js"),
);

async function runQaTelegram(opts: LiveTransportQaCommandOptions) {
  await (await loadTelegramQaCliRuntime()).runQaTelegramCommand(opts);
}

const telegramQaAdapterFactory: NonNullable<LiveTransportQaCliRegistration["adapterFactory"]> = {
  id: "telegram",
  scenarioIds: ["channel-chat-baseline", ...TELEGRAM_QA_ALL_SCENARIO_IDS],
  matches: ({ channelId, driver }) => driver === "live" && channelId === "telegram",
  async create(context) {
    return await (await loadTelegramQaAdapterRuntime()).createTelegramQaTransportAdapter(context);
  },
};

export const telegramQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "telegram",
    adapterFactory: telegramQaAdapterFactory,
    credentialOptions: {
      sourceDescription: "Credential source for Telegram QA: env or convex (default: env)",
      roleDescription:
        "Credential role for convex auth: maintainer or ci (default: ci in CI, maintainer otherwise)",
    },
    description: "Run the manual Telegram live QA lane against a private bot-to-bot group harness",
    listScenariosHelp: "Print available Telegram scenario ids and exit",
    outputDirHelp: "Telegram QA artifact directory",
    profileHelp: "QA Lab Telegram profile: release or all (default: release)",
    run: runQaTelegram,
    scenarioHelp: "Run only the named Telegram QA scenario (repeatable)",
    sutAccountHelp: "Temporary Telegram account id inside the QA gateway config",
  });
