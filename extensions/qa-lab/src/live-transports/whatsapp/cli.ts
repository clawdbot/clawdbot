// Qa Lab plugin module implements cli behavior.
import {
  createLiveTransportQaAdapterFactory,
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  loadLiveTransportQaSuiteRuntime,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "../shared/live-transport-cli.js";
import { resolveWhatsAppQaScenarioIds } from "./scenario-selection.js";

const loadWhatsAppQaAdapterRuntime = createLazyCliRuntimeLoader<
  typeof import("./adapter.runtime.js")
>(() => import("./adapter.runtime.js"));

async function runQaWhatsApp(opts: LiveTransportQaCommandOptions) {
  const runtime = await loadLiveTransportQaSuiteRuntime();
  await runtime.runLiveTransportQaSuiteCommand({
    channelId: "whatsapp",
    defaultProviderMode: "live-frontier",
    options: opts,
    selectScenarioIds: resolveWhatsAppQaScenarioIds,
  });
}

export const whatsappQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "whatsapp",
    adapterFactory: createLiveTransportQaAdapterFactory({
      id: "whatsapp",
      async create(context) {
        return (await loadWhatsAppQaAdapterRuntime()).createWhatsAppQaTransportAdapter(context);
      },
    }),
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
