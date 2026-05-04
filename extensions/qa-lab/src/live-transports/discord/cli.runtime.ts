import type { LiveTransportQaCommandOptions } from "../shared/live-transport-cli.js";
import {
  printLiveTransportQaArtifacts,
  resolveLiveTransportQaRunOptions,
} from "../shared/live-transport-cli.runtime.js";
import { runDiscordQaLive } from "./discord-live.runtime.js";

export async function runQaDiscordCommand(opts: LiveTransportQaCommandOptions) {
  const runOptions = resolveLiveTransportQaRunOptions(opts);
  const result = await runDiscordQaLive(runOptions);
  printLiveTransportQaArtifacts("Discord QA", {
    report: result.reportPath,
    summary: result.summaryPath,
    "observed messages": result.observedMessagesPath,
    ...(result.reactionTimelinesPath ? { "reaction timelines": result.reactionTimelinesPath } : {}),
    ...(result.gatewayDebugDirPath ? { "gateway debug logs": result.gatewayDebugDirPath } : {}),
  });
  if (
    !runOptions.allowFailures &&
    result.scenarios.some((scenario) => scenario.status === "fail")
  ) {
    process.exitCode = 1;
  }
}
