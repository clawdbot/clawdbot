// Qa Lab plugin module implements cli behavior.
import {
  createLiveTransportQaAdapterFactory,
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  loadLiveTransportQaSuiteRuntime,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";
import { resolveDiscordQaScenarioIds } from "./scenario-selection.js";

const loadDiscordQaAdapterRuntime = createLazyCliRuntimeLoader<
  typeof import("./adapter.runtime.js")
>(() => import("./adapter.runtime.js"));

async function runQaDiscord(opts: LiveTransportQaCommandOptions) {
  const runtime = await loadLiveTransportQaSuiteRuntime();
  await runtime.runLiveTransportQaSuiteCommand({
    channelId: "discord",
    defaultProviderMode: "live-frontier",
    options: opts,
    selectScenarioIds: resolveDiscordQaScenarioIds,
  });
}

export const discordQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "discord",
    adapterFactory: createLiveTransportQaAdapterFactory({
      id: "discord",
      supportsModuleFlows: true,
      async create(context) {
        return (await loadDiscordQaAdapterRuntime()).createDiscordQaTransportAdapter(context);
      },
    }),
    credentialOptions: {
      sourceDescription: "Credential source for Discord QA: env or convex (default: env)",
      roleDescription:
        "Credential role for convex auth: maintainer or ci (default: ci in CI, maintainer otherwise)",
    },
    channelDriverHelp:
      "Discord transport boundary: live (default) or Crabline local provider server",
    description: "Run Discord QA through the live service or Crabline local provider server",
    listScenariosHelp: "Print the selected Discord scenario ids and exit",
    outputDirHelp: "Discord QA artifact directory",
    scenarioHelp: "Run only the named Discord QA scenario (repeatable)",
    sutAccountHelp: "Temporary Discord account id inside the QA gateway config",
    run: runQaDiscord,
  });
