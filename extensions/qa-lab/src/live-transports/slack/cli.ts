// Qa Lab plugin module implements cli behavior.
import {
  createLazyCliRuntimeLoader,
  createStandardLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
} from "../shared/live-transport-cli.js";

const loadSlackQaAdapterRuntime = createLazyCliRuntimeLoader<typeof import("./adapter.runtime.js")>(
  () => import("./adapter.runtime.js"),
);

export const slackQaCliRegistration: LiveTransportQaCliRegistration =
  createStandardLiveTransportQaCliRegistration({
    channelId: "slack",
    channelLabel: "Slack",
    async createAdapter(context) {
      return (await loadSlackQaAdapterRuntime()).createSlackQaTransportAdapter(context);
    },
    description: "Run the Slack live QA lane against a private bot-to-bot channel harness",
  });
