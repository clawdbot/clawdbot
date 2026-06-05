// Qa Matrix plugin module implements live transport cli behavior.
import path from "node:path";
import { resolveRepoRelativeOutputDir } from "../cli-paths.js";
import type { QaProviderMode } from "../run-config.js";
import { normalizeQaProviderMode } from "../run-config.js";
import type { LiveTransportQaCommandOptions } from "./live-transport-cli.js";

export function resolveLiveTransportQaRunOptions(
  opts: LiveTransportQaCommandOptions,
): LiveTransportQaCommandOptions & {
  outputDir: string;
  repoRoot: string;
  providerMode: QaProviderMode;
} {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir =
    resolveRepoRelativeOutputDir(repoRoot, opts.outputDir) ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `matrix-${Date.now().toString(36)}`);
  return {
    repoRoot,
    outputDir,
    providerMode:
      opts.providerMode === undefined
        ? "live-frontier"
        : normalizeQaProviderMode(opts.providerMode),
    primaryModel: opts.primaryModel,
    alternateModel: opts.alternateModel,
    fastMode: opts.fastMode,
    failFast: opts.failFast,
    profile: opts.profile?.trim(),
    scenarioIds: opts.scenarioIds,
    sutAccountId: opts.sutAccountId,
    credentialSource: opts.credentialSource?.trim(),
    credentialRole: opts.credentialRole?.trim(),
  };
}
