/**
 * Non-interactive onboarding command dispatcher.
 *
 * This module validates the existing config snapshot, routes local/remote
 * setup, and handles explicit migration imports without interactive prompts.
 */
import { isDeepStrictEqual } from "node:util";
import { formatCliCommand } from "../cli/command-format.js";
import { ConfigMutationConflictError, replaceConfigFile } from "../config/config.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { logConfigUpdated } from "../config/logging.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { withSetupMigrationTargetLock } from "../wizard/setup.migration-snapshot.js";
import { createNonInteractiveLoggingPrompter } from "./non-interactive-prompter.js";
import { runNonInteractiveLocalSetup } from "./onboard-non-interactive/local.js";
import { runNonInteractiveRemoteSetup } from "./onboard-non-interactive/remote.js";
import { rejectOnboardingOption } from "./onboard-options.js";
import type { OnboardOptions } from "./onboard-types.js";

function isMigrationImport(opts: OnboardOptions): boolean {
  return Boolean(
    opts.importFrom || opts.importSource || opts.importSecrets || opts.flow === "import",
  );
}

/** Runs a setup migration import with non-interactive prompt failures. */
async function runNonInteractiveMigrationImport(params: {
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
}) {
  const providerId = params.opts.importFrom?.trim();
  if (!providerId) {
    // Migration import cannot safely prompt in non-interactive mode; require the
    // provider id so the import path is deterministic.
    rejectOnboardingOption(
      params.opts,
      params.runtime,
      `--import-from is required for non-interactive migration import. Run ${formatCliCommand("openclaw migrate list")} to choose a provider.`,
    );
    return;
  }
  const { detectSetupMigrationSources, runSetupMigrationImport } =
    await import("../wizard/setup.migration-import.js");
  const detections = await detectSetupMigrationSources({
    config: params.baseConfig,
    runtime: params.runtime,
  });
  const outcome = await runSetupMigrationImport({
    opts: { ...params.opts, importFrom: providerId, nonInteractive: true },
    baseConfig: params.baseConfig,
    detections,
    prompter: createNonInteractiveLoggingPrompter(
      params.runtime,
      (message) =>
        `Non-interactive migration import needs explicit flags before prompting: ${message}`,
    ),
    runtime: params.runtime,
    async readConfigFile() {
      const snapshot = await readConfigFileSnapshot();
      if (!snapshot.valid) {
        throw new Error("Migration target config became invalid. Run `openclaw doctor`.");
      }
      return snapshot.exists ? (snapshot.sourceConfig ?? snapshot.config) : {};
    },
    async commitConfigFile(config, expectedConfig) {
      const latest = await readConfigFileSnapshot();
      if (!latest.valid) {
        throw new Error("Migration target config became invalid. Run `openclaw doctor`.");
      }
      const latestConfig = latest.exists ? (latest.sourceConfig ?? latest.config) : {};
      if (!isDeepStrictEqual(latestConfig, expectedConfig)) {
        throw new ConfigMutationConflictError("config changed during migration promotion");
      }
      const committed = await replaceConfigFile({
        sourceConfig: config,
        snapshot: latest,
        ...(latest.hash !== undefined ? { baseHash: latest.hash } : {}),
        writeOptions: { allowConfigSizeDrop: true },
      });
      logConfigUpdated(params.runtime);
      return committed.nextConfig;
    },
  });
  if (outcome.kind === "back") {
    throw new Error("Non-interactive migration import cannot navigate back.");
  }
  await outcome.acknowledgePromotion?.();
}

async function runNonInteractiveSetupExclusive(opts: OnboardOptions, runtime: RuntimeEnv) {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    // Avoid rewriting an invalid config snapshot; doctor owns recovery so setup
    // does not erase malformed user state.
    rejectOnboardingOption(
      opts,
      runtime,
      `Config invalid. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run setup.`,
    );
    return;
  }

  const baseConfig: OpenClawConfig = snapshot.valid
    ? snapshot.exists
      ? (snapshot.sourceConfig ?? snapshot.config)
      : {}
    : {};
  const mode = opts.mode ?? "local";
  if (mode !== "local" && mode !== "remote") {
    rejectOnboardingOption(
      opts,
      runtime,
      `Invalid --mode "${String(mode)}". Use "local" or "remote", or run ${formatCliCommand("openclaw onboard")} for interactive setup.`,
    );
    return;
  }

  if (isMigrationImport(opts)) {
    // Import flow owns its own commit path because migrations may intentionally
    // shrink legacy config after extracting credentials.
    await runNonInteractiveMigrationImport({ opts, runtime, baseConfig });
    return;
  }

  if (mode === "remote") {
    await runNonInteractiveRemoteSetup({ opts, runtime, baseConfig, baseHash: snapshot.hash });
    return;
  }

  await runNonInteractiveLocalSetup({
    opts,
    runtime,
    baseConfig,
    sourceConfigBeforeMigrations: snapshot.sourceConfigBeforeMigrations ?? {},
    baseHash: snapshot.hash,
  });
}

/** Runs non-interactive onboarding in local, remote, or migration-import mode. */
export async function runNonInteractiveSetup(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  await withSetupMigrationTargetLock(resolveStateDir(), async () => {
    if (isMigrationImport(opts)) {
      // Migration must inspect freshness before opening the shared lease DB.
      await runNonInteractiveSetupExclusive(opts, runtime);
      return;
    }
    await withOpenClawStateLease(
      {
        scope: "core:onboarding",
        key: "global",
        database: { scope: "shared" },
        // Bound one run to five minutes while allowing one predecessor to finish.
        leaseMs: 5 * 60_000,
        waitMs: 10 * 60_000,
        leaseLabel: "non-interactive onboarding lease",
        operationLabel: "onboarding.non-interactive.lease",
      },
      async () =>
        await withPluginLifecycleLease({}, async () =>
          runNonInteractiveSetupExclusive(opts, runtime),
        ),
    );
  });
}
