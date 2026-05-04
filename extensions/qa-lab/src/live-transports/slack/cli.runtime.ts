import type { LiveTransportQaCommandOptions } from "../shared/live-transport-cli.js";
import {
  printLiveTransportQaArtifacts,
  resolveLiveTransportQaRunOptions,
} from "../shared/live-transport-cli.runtime.js";
import { runSlackQaLive } from "./slack-live.runtime.js";

export async function runQaSlackCommand(opts: LiveTransportQaCommandOptions) {
  const runOptions = resolveLiveTransportQaRunOptions(opts);
  const result = await runSlackQaLive(runOptions);
  printLiveTransportQaArtifacts("Slack QA", {
    report: result.reportPath,
    summary: result.summaryPath,
    "observed messages": result.observedMessagesPath,
    ...(result.gatewayDebugDirPath ? { "gateway debug logs": result.gatewayDebugDirPath } : {}),
  });
  if (
    !runOptions.allowFailures &&
    result.scenarios.some((scenario) => scenario.status === "fail")
  ) {
    process.exitCode = 1;
  }
}
