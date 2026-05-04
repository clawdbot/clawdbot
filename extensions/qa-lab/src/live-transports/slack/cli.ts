import {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";

type SlackQaCliRuntime = typeof import("./cli.runtime.js");

const loadSlackQaCliRuntime = createLazyCliRuntimeLoader<SlackQaCliRuntime>(
  () => import("./cli.runtime.js"),
);

async function runQaSlack(opts: LiveTransportQaCommandOptions) {
  const runtime = await loadSlackQaCliRuntime();
  await runtime.runQaSlackCommand(opts);
}

export const slackQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "slack",
    credentialOptions: {
      sourceDescription: "Credential source for Slack QA: env or convex (default: env)",
      roleDescription:
        "Credential role for convex auth: maintainer or ci (default: ci in CI, maintainer otherwise)",
    },
    description: "Run the Slack live QA lane against a private bot-to-bot channel harness",
    outputDirHelp: "Slack QA artifact directory",
    scenarioHelp: "Run only the named Slack QA scenario (repeatable)",
    sutAccountHelp: "Temporary Slack account id inside the QA gateway config",
    run: runQaSlack,
  });
