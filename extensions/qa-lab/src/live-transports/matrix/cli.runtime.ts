import type { LiveTransportQaCommandOptions } from "../shared/live-transport-cli.js";
import {
  printLiveTransportQaArtifacts,
  resolveLiveTransportQaRunOptions,
} from "../shared/live-transport-cli.runtime.js";
import { runMatrixQaLive } from "./matrix-live.runtime.js";

export async function runQaMatrixCommand(opts: LiveTransportQaCommandOptions) {
  const result = await runMatrixQaLive(resolveLiveTransportQaRunOptions(opts));
  printLiveTransportQaArtifacts("Matrix QA", {
    report: result.reportPath,
    summary: result.summaryPath,
    "observed events": result.observedEventsPath,
  });
}
