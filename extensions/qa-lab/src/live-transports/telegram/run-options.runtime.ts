// Qa Lab plugin module normalizes Telegram live-run options.
import path from "node:path";
import type { LiveTransportQaCommandOptions } from "openclaw/plugin-sdk/qa-runtime";
import { resolveRepoRelativeOutputDir } from "../../cli-paths.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "../../providers/index.js";
import type { QaProviderMode } from "../../run-config.js";
import { normalizeQaProviderMode } from "../../run-config.js";

function normalizeTelegramModelRef(input: string | undefined) {
  const model = input?.trim();
  return model && model.length > 0 ? model : undefined;
}

export function resolveTelegramQaRunOptions(
  opts: LiveTransportQaCommandOptions,
): LiveTransportQaCommandOptions & {
  repoRoot: string;
  providerMode: QaProviderMode;
} {
  const credentialSource = opts.credentialSource?.trim().toLowerCase() || "convex";
  if (credentialSource !== "convex") {
    throw new Error("Telegram QA supports only --credential-source convex.");
  }
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
    primaryModel: normalizeTelegramModelRef(opts.primaryModel),
    alternateModel: normalizeTelegramModelRef(opts.alternateModel),
    fastMode: opts.fastMode,
    allowFailures: opts.allowFailures,
    failFast: opts.failFast,
    scenarioIds: opts.scenarioIds,
    listScenarios: opts.listScenarios,
    sutAccountId: opts.sutAccountId,
    credentialSource,
    credentialRole: opts.credentialRole?.trim(),
  };
}
