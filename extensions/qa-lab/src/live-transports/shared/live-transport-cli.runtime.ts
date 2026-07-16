// Qa Lab plugin module implements live transport cli behavior.
import path from "node:path";
import { resolveRepoRelativeOutputDir } from "../../cli-paths.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "../../providers/index.js";
import type { QaProviderMode } from "../../run-config.js";
import { normalizeQaProviderMode } from "../../run-config.js";
import type { LiveTransportQaCommandOptions } from "./live-transport-cli.js";

function normalizeLiveTransportModelRef(input: string | undefined) {
  const model = input?.trim();
  return model && model.length > 0 ? model : undefined;
}

export function resolveLiveTransportQaRunOptions(
  opts: LiveTransportQaCommandOptions,
): LiveTransportQaCommandOptions & {
  repoRoot: string;
  providerMode: QaProviderMode;
} {
  return {
    repoRoot: path.resolve(opts.repoRoot ?? process.cwd()),
    outputDir: resolveRepoRelativeOutputDir(
      path.resolve(opts.repoRoot ?? process.cwd()),
      opts.outputDir,
    ),
    providerMode:
      opts.providerMode === undefined
        ? DEFAULT_QA_LIVE_PROVIDER_MODE
        : normalizeQaProviderMode(opts.providerMode),
    primaryModel: normalizeLiveTransportModelRef(opts.primaryModel),
    alternateModel: normalizeLiveTransportModelRef(opts.alternateModel),
    fastMode: opts.fastMode,
    allowFailures: opts.allowFailures,
    failFast: opts.failFast,
    scenarioIds: opts.scenarioIds,
    listScenarios: opts.listScenarios,
    sutAccountId: opts.sutAccountId,
    credentialSource: opts.credentialSource?.trim(),
    credentialRole: opts.credentialRole?.trim(),
  };
}
