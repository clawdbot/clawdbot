import {
  WHATSAPP_LIVE_DEFAULT_CANONICAL_SCENARIO_IDS,
  WHATSAPP_ROUTING_CANONICAL_SCENARIO_IDS,
} from "../shared/canonical-scenarios.js";
// Qa Lab plugin module implements cli behavior.
import {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";

type WhatsAppQaAdapterRuntime = typeof import("./adapter.runtime.js");
type WhatsAppQaCliRuntime = typeof import("./cli.runtime.js");

const loadWhatsAppQaAdapterRuntime = createLazyCliRuntimeLoader<WhatsAppQaAdapterRuntime>(
  () => import("./adapter.runtime.js"),
);
const loadWhatsAppQaCliRuntime = createLazyCliRuntimeLoader<WhatsAppQaCliRuntime>(
  () => import("./cli.runtime.js"),
);

async function runQaWhatsApp(opts: LiveTransportQaCommandOptions) {
  await (await loadWhatsAppQaCliRuntime()).runQaWhatsAppCommand(opts);
}

const whatsappQaAdapterFactory: NonNullable<LiveTransportQaCliRegistration["adapterFactory"]> = {
  id: "whatsapp",
  scenarioIds: [
    "dm-chat-baseline",
    ...WHATSAPP_ROUTING_CANONICAL_SCENARIO_IDS,
    ...WHATSAPP_LIVE_DEFAULT_CANONICAL_SCENARIO_IDS,
  ],
  matches: ({ channelId, driver }) => driver === "live" && channelId === "whatsapp",
  async create(context) {
    return await (await loadWhatsAppQaAdapterRuntime()).createWhatsAppQaTransportAdapter(context);
  },
};

export const whatsappQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "whatsapp",
    adapterFactory: whatsappQaAdapterFactory,
    credentialOptions: {
      sourceDescription: "Credential source for WhatsApp QA: env or convex (default: env)",
      roleDescription:
        "Credential role for convex auth: maintainer or ci (default: ci in CI, maintainer otherwise)",
    },
    description: "Run the WhatsApp live QA lane against two pre-linked Web sessions",
    outputDirHelp: "WhatsApp QA artifact directory",
    run: runQaWhatsApp,
    scenarioHelp: "Run only the named WhatsApp QA scenario (repeatable)",
    sutAccountHelp: "Temporary WhatsApp account id inside the QA gateway config",
  });
