// Qa Lab plugin module implements cli behavior.
import {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";

type SlackQaAdapterRuntime = typeof import("./adapter.runtime.js");
type SlackQaCliRuntime = typeof import("./cli.runtime.js");

const loadSlackQaAdapterRuntime = createLazyCliRuntimeLoader<SlackQaAdapterRuntime>(
  () => import("./adapter.runtime.js"),
);
const loadSlackQaCliRuntime = createLazyCliRuntimeLoader<SlackQaCliRuntime>(
  () => import("./cli.runtime.js"),
);

async function runQaSlack(opts: LiveTransportQaCommandOptions) {
  await (await loadSlackQaCliRuntime()).runQaSlackCommand(opts);
}

const slackQaAdapterFactory: NonNullable<LiveTransportQaCliRegistration["adapterFactory"]> = {
  id: "slack",
  scenarioIds: [
    "channel-chat-baseline",
    "channel-canary",
    "channel-mention-gating",
    "channel-top-level-reply-shape",
    "thread-follow-up",
    "thread-isolation",
  ],
  matches: ({ channelId, driver }) => driver === "live" && channelId === "slack",
  async create(context) {
    return await (await loadSlackQaAdapterRuntime()).createSlackQaTransportAdapter(context);
  },
};

export const slackQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "slack",
    adapterFactory: slackQaAdapterFactory,
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
