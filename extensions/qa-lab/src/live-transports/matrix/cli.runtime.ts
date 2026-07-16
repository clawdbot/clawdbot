// QA Lab Matrix delegates CLI profile selection into the shared suite host.
import { runQaSuiteCommand } from "../../cli.runtime.js";
import { normalizeQaProviderMode } from "../../run-config.js";
import type { LiveTransportQaCommandOptions } from "../shared/live-transport-cli.js";
import { resolveMatrixQaScenarioIds } from "./profiles.js";

export async function runQaMatrixCommand(opts: LiveTransportQaCommandOptions) {
  const credentialSource = opts.credentialSource?.trim().toLowerCase();
  if (credentialSource && credentialSource !== "env") {
    throw new Error(
      "QA Lab Matrix supports only --credential-source env because its homeserver is disposable and local.",
    );
  }
  if (opts.credentialRole?.trim()) {
    throw new Error("QA Lab Matrix does not use credential roles.");
  }

  return await runQaSuiteCommand({
    repoRoot: opts.repoRoot,
    outputDir: opts.outputDir,
    providerMode:
      opts.providerMode === undefined ? undefined : normalizeQaProviderMode(opts.providerMode),
    primaryModel: opts.primaryModel,
    alternateModel: opts.alternateModel,
    fastMode: opts.fastMode,
    allowFailures: opts.allowFailures,
    failFast: opts.failFast,
    channelDriver: "live",
    channel: "matrix",
    concurrency: 1,
    scenarioIds: resolveMatrixQaScenarioIds({
      profile: opts.profile,
      scenarioIds: opts.scenarioIds,
    }),
    sutAccountId: opts.sutAccountId,
  });
}
