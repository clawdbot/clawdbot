import {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  runLiveTransportQaSuiteCommand,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "openclaw/plugin-sdk/qa-runner-runtime";

const DEFAULT_MSTEAMS_QA_SCENARIOS = ["channel-canary"] as const;

const loadMSTeamsQaAdapterRuntime = createLazyCliRuntimeLoader<
  typeof import("./adapter.runtime.js")
>(() => import("./adapter.runtime.js"));

async function runQaMSTeams(options: LiveTransportQaCommandOptions) {
  await runLiveTransportQaSuiteCommand({
    channelId: "msteams",
    defaultProviderMode: "mock-openai",
    options,
    selectScenarioIds: ({ scenarioIds }) =>
      scenarioIds?.length ? [...scenarioIds] : [...DEFAULT_MSTEAMS_QA_SCENARIOS],
  });
}

export const msteamsQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "msteams",
    adapterFactory: {
      id: "msteams",
      isolatesInstances: true,
      matches: ({ channelId, driver }) => channelId === "msteams" && driver === "live",
      async create(context) {
        return await (await loadMSTeamsQaAdapterRuntime()).createMSTeamsQaTransportAdapter(context);
      },
    },
    defaultProviderMode: "mock-openai",
    description: "Run Microsoft Teams Gateway QA against a local Bot Framework mock",
    providerModeHelp: "Provider mode: mock-openai, aimock, or live-frontier",
    outputDirHelp: "Microsoft Teams QA artifact directory",
    allowFailuresHelp: "Write artifacts without setting a failing exit code when scenarios fail",
    scenarioHelp: "Run only the named Microsoft Teams QA scenario (repeatable)",
    sutAccountHelp: "Normalized Microsoft Teams SUT account id in QA artifacts",
    run: runQaMSTeams,
  });
