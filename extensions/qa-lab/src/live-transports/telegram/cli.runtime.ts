import type { LiveTransportQaCommandOptions } from "../shared/live-transport-cli.js";
import {
  printLiveTransportQaArtifacts,
  resolveLiveTransportQaRunOptions,
} from "../shared/live-transport-cli.runtime.js";
import { runTelegramQaLive } from "./telegram-live.runtime.js";

export async function runQaTelegramCommand(opts: LiveTransportQaCommandOptions) {
  const result = await runTelegramQaLive(resolveLiveTransportQaRunOptions(opts));
  printLiveTransportQaArtifacts("Telegram QA", {
    report: result.reportPath,
    summary: result.summaryPath,
    "observed messages": result.observedMessagesPath,
  });
}
