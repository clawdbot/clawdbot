// Qa Lab plugin module implements cli behavior.
import {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";
import { DISCORD_QA_DEFAULT_SCENARIO_IDS } from "./profiles.js";

type DiscordQaCliRuntime = typeof import("./cli.runtime.js");
type DiscordQaAdapterRuntime = typeof import("./adapter.runtime.js");

const loadDiscordQaCliRuntime = createLazyCliRuntimeLoader<DiscordQaCliRuntime>(
  () => import("./cli.runtime.js"),
);
const loadDiscordQaAdapterRuntime = createLazyCliRuntimeLoader<DiscordQaAdapterRuntime>(
  () => import("./adapter.runtime.js"),
);

async function runQaDiscord(opts: LiveTransportQaCommandOptions) {
  const runtime = await loadDiscordQaCliRuntime();
  await runtime.runQaDiscordCommand(opts);
}

export const discordQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "discord",
    adapterFactory: {
      id: "discord",
      scenarioIds: DISCORD_QA_DEFAULT_SCENARIO_IDS,
      matches: ({ channelId, driver }) => driver === "live" && channelId === "discord",
      async create(context) {
        return await (await loadDiscordQaAdapterRuntime()).createDiscordQaTransportAdapter(context);
      },
    },
    credentialOptions: {
      sourceDescription: "Credential source for Discord QA: env or convex (default: env)",
      roleDescription:
        "Credential role for convex auth: maintainer or ci (default: ci in CI, maintainer otherwise)",
    },
    description: "Run the Discord live QA lane against a private guild bot-to-bot harness",
    outputDirHelp: "Discord QA artifact directory",
    scenarioHelp: "Run only the named Discord QA scenario (repeatable)",
    sutAccountHelp: "Temporary Discord account id inside the QA gateway config",
    run: runQaDiscord,
  });
