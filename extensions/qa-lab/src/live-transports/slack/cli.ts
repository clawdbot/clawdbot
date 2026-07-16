// Qa Lab plugin module implements cli behavior.
import {
  createLiveTransportQaAdapterFactory,
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  loadLiveTransportQaSuiteRuntime,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";
import { resolveSlackQaScenarioIds } from "./scenario-selection.js";

const loadSlackQaAdapterRuntime = createLazyCliRuntimeLoader<typeof import("./adapter.runtime.js")>(
  () => import("./adapter.runtime.js"),
);

async function runQaSlack(opts: LiveTransportQaCommandOptions) {
  const runtime = await loadLiveTransportQaSuiteRuntime();
  await runtime.runLiveTransportQaSuiteCommand({
    channelId: "slack",
    defaultProviderMode: "live-frontier",
    options: opts,
    selectScenarioIds: resolveSlackQaScenarioIds,
  });
}

export const slackQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "slack",
    adapterFactory: createLiveTransportQaAdapterFactory({
      id: "slack",
      async create(context) {
        return (await loadSlackQaAdapterRuntime()).createSlackQaTransportAdapter(context);
      },
    }),
    credentialOptions: {
      sourceDescription: "Credential source for Slack QA: env or convex (default: env)",
      roleDescription:
        "Credential role for convex auth: maintainer or ci (default: ci in CI, maintainer otherwise)",
    },
    description: "Run the Slack live QA lane against a private bot-to-bot channel harness",
    outputDirHelp: "Slack QA artifact directory",
    run: runQaSlack,
    scenarioHelp: "Run only the named Slack QA scenario (repeatable)",
    sutAccountHelp: "Temporary Slack account id inside the QA gateway config",
  });
