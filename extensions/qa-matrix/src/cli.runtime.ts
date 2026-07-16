import { runMatrixQaLive } from "./runners/contract/runtime.js";
import type { LiveTransportQaCommandOptions } from "./shared/live-transport-cli.js";
import {
  printLiveTransportQaArtifacts,
  resolveLiveTransportQaRunOptions,
} from "./shared/live-transport-cli.runtime.js";

export async function runQaMatrixCommand(opts: LiveTransportQaCommandOptions) {
  const runOptions = resolveLiveTransportQaRunOptions(opts);
  const credentialSource = runOptions.credentialSource?.toLowerCase();
  if (credentialSource && credentialSource !== "env") {
    throw new Error(
      "Matrix QA currently supports only --credential-source env (disposable local harness).",
    );
  }

  const result = await runMatrixQaLive(runOptions);
  printLiveTransportQaArtifacts("Matrix QA", {
    report: result.reportPath,
    summary: result.summaryPath,
    "observed events": result.observedEventsPath,
  });
}
