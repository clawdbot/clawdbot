import { runQaSuiteCommand } from "../../cli.runtime.js";
import type { LiveTransportQaCommandOptions } from "../shared/live-transport-cli.js";
import { resolveLiveTransportQaRunOptions } from "../shared/live-transport-cli.runtime.js";
import { resolveWhatsAppQaScenarioIds } from "./profiles.js";

export async function runQaWhatsAppCommand(opts: LiveTransportQaCommandOptions) {
  const runOptions = resolveLiveTransportQaRunOptions(opts);
  return await runQaSuiteCommand({
    repoRoot: opts.repoRoot,
    outputDir: opts.outputDir,
    providerMode: runOptions.providerMode,
    primaryModel: runOptions.primaryModel,
    alternateModel: runOptions.alternateModel,
    fastMode: runOptions.fastMode,
    allowFailures: runOptions.allowFailures,
    failFast: runOptions.failFast,
    channelDriver: "live",
    channel: "whatsapp",
    concurrency: 1,
    scenarioIds: resolveWhatsAppQaScenarioIds({
      providerMode: runOptions.providerMode,
      scenarioIds: runOptions.scenarioIds,
    }),
    sutAccountId: runOptions.sutAccountId,
    credentialSource: runOptions.credentialSource,
    credentialRole: runOptions.credentialRole,
    explicitScenarioSelection: Boolean(runOptions.scenarioIds?.length),
  });
}
