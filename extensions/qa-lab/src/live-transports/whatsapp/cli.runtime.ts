import { readQaSuiteFailedOrSkippedScenarioCountFromFile } from "../../suite-summary.js";
// Qa Lab plugin module implements cli behavior.
import { printLiveTransportQaArtifacts } from "../shared/live-artifacts.js";
import type { LiveTransportQaCommandOptions } from "../shared/live-transport-cli.js";
import { resolveLiveTransportQaRunOptions } from "../shared/live-transport-cli.runtime.js";
import { runWhatsAppQaLive } from "./whatsapp-live.runtime.js";

export async function runQaWhatsAppCommand(opts: LiveTransportQaCommandOptions) {
  const runOptions = resolveLiveTransportQaRunOptions(opts);
  const result = await runWhatsAppQaLive(runOptions);
  printLiveTransportQaArtifacts("WhatsApp QA", {
    report: result.reportPath,
    summary: result.summaryPath,
    "observed messages": result.observedMessagesPath,
    ...(result.gatewayDebugDirPath ? { "gateway debug logs": result.gatewayDebugDirPath } : {}),
  });
  if (!runOptions.allowFailures) {
    const blockingScenarioCount = await readQaSuiteFailedOrSkippedScenarioCountFromFile(
      result.summaryPath,
    );
    if (blockingScenarioCount > 0) {
      process.exitCode = 1;
    }
  }
}
