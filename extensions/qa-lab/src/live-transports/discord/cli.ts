// Qa Lab plugin module implements cli behavior.
import {
  createLazyCliRuntimeLoader,
  createStandardLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
} from "../shared/live-transport-cli.js";

const loadDiscordQaAdapterRuntime = createLazyCliRuntimeLoader<
  typeof import("./adapter.runtime.js")
>(() => import("./adapter.runtime.js"));

export const discordQaCliRegistration: LiveTransportQaCliRegistration =
  createStandardLiveTransportQaCliRegistration({
    channelId: "discord",
    channelLabel: "Discord",
    async createAdapter(context) {
      return (await loadDiscordQaAdapterRuntime()).createDiscordQaTransportAdapter(context);
    },
    description: "Run the Discord live QA lane against a private guild bot-to-bot harness",
  });
