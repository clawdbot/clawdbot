// Qa Lab plugin module implements cli behavior.
import {
  createLiveTransportQaAdapterFactory,
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";

const loadTelegramQaAdapterRuntime = createLazyCliRuntimeLoader<
  typeof import("./adapter.runtime.js")
>(() => import("./adapter.runtime.js"));
const loadTelegramQaCliRuntime = createLazyCliRuntimeLoader<typeof import("./cli.runtime.js")>(
  () => import("./cli.runtime.js"),
);

export const telegramQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "telegram",
    adapterFactory: createLiveTransportQaAdapterFactory({
      id: "telegram",
      async create(context) {
        return (await loadTelegramQaAdapterRuntime()).createTelegramQaTransportAdapter(context);
      },
    }),
    credentialOptions: {
      sourceDescription: "Credential source for Telegram QA (must be convex; default: convex)",
      roleDescription:
        "Credential role for convex auth: maintainer or ci (default: ci in CI, maintainer otherwise)",
    },
    description: "Run Telegram Test Server QA with a Convex-leased real-user driver",
    listScenariosHelp: "Print available Telegram scenario ids and exit",
    outputDirHelp: "Telegram QA artifact directory",
    profileHelp: "Taxonomy profile for Telegram scenario selection (default: release)",
    async run(opts: LiveTransportQaCommandOptions) {
      await (await loadTelegramQaCliRuntime()).runQaTelegramCommand(opts);
    },
    scenarioHelp: "Run only the named Telegram QA scenario (repeatable)",
    sutAccountHelp: "Temporary Telegram account id inside the QA gateway config",
  });
