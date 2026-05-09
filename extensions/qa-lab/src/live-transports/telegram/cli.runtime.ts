import type { LiveTransportQaCommandOptions } from "../shared/live-transport-cli.js";
import {
  printLiveTransportQaArtifacts,
  resolveLiveTransportQaRunOptions,
} from "../shared/live-transport-cli.runtime.js";
import { listTelegramQaScenarioCatalog, runTelegramQaLive } from "./telegram-live.runtime.js";

export async function runQaTelegramCommand(opts: LiveTransportQaCommandOptions) {
  const runOptions = resolveLiveTransportQaRunOptions(opts);
  if (runOptions.listScenarios) {
    for (const scenario of listTelegramQaScenarioCatalog(runOptions.providerMode)) {
      const defaultLabel = scenario.defaultEnabled ? "default" : "optional";
      const refs =
        scenario.regressionRefs.length > 0 ? ` refs=${scenario.regressionRefs.join(",")}` : "";
      process.stdout.write(
        `${scenario.id}\t${defaultLabel}\t${scenario.title}\t${scenario.rationale}${refs}\n`,
      );
    }
    return;
  }
  const result = await runTelegramQaLive(runOptions);
  printLiveTransportQaArtifacts("Telegram QA", {
    report: result.reportPath,
    summary: result.summaryPath,
    "observed messages": result.observedMessagesPath,
  });
  if (
    !runOptions.allowFailures &&
    result.scenarios.some((scenario) => scenario.status === "fail")
  ) {
    process.exitCode = 1;
  }
}
