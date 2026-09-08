// Qa Lab plugin module implements cli behavior.
import {
  createLazyCliRuntimeLoader,
  createStandardLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
} from "../shared/live-transport-cli.js";

const loadWhatsAppQaAdapterRuntime = createLazyCliRuntimeLoader<
  typeof import("./adapter.runtime.js")
>(() => import("./adapter.runtime.js"));

export const whatsappQaCliRegistration: LiveTransportQaCliRegistration =
  createStandardLiveTransportQaCliRegistration({
    channelId: "whatsapp",
    channelLabel: "WhatsApp",
    async createAdapter(context) {
      return (await loadWhatsAppQaAdapterRuntime()).createWhatsAppQaTransportAdapter(context);
    },
    description: "Run the WhatsApp live QA lane against two pre-linked Web sessions",
  });
