import path from "node:path";
import { resolveRepoRelativeOutputDir } from "../../cli-paths.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "../../providers/index.js";
import type { QaProviderMode } from "../../run-config.js";
import { normalizeQaProviderMode } from "../../run-config.js";
import type { LiveTransportQaCommandOptions } from "./live-transport-cli.js";

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
    primaryModel: opts.primaryModel,
    alternateModel: opts.alternateModel,
    fastMode: opts.fastMode,
    scenarioIds: opts.scenarioIds,
    sutAccountId: opts.sutAccountId,
    credentialSource: opts.credentialSource?.trim(),
    credentialRole: opts.credentialRole?.trim(),
  };
}

export function printLiveTransportQaArtifacts(
  laneLabel: string,
  artifacts: Record<string, string>,
) {
  for (const [label, filePath] of Object.entries(artifacts)) {
    process.stdout.write(`${laneLabel} ${label}: ${filePath}\n`);
  }
}
