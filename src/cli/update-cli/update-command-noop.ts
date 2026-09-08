import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import { createConfigIO } from "../../config/io.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { collectMissingPluginInstallPayloads } from "../../plugins/payload-verification.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { printResult } from "./progress.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  maybeRepairLegacyConfigForUpdateChannel,
  persistRequestedUpdateChannel,
} from "./update-command-config.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

/** A same-version request inspects payloads without repairing plugins or touching the service. */
export async function finishAlreadyCurrentUpdate(params: {
  opts: UpdateCommandOptions;
  result: UpdateRunResult;
  env?: NodeJS.ProcessEnv;
  legacyConfigPlan?: LegacyConfigUpdatePlan;
}): Promise<void> {
  const run = params.opts.run!;
  const env = params.env ?? run.env;
  const startedAtMs = Date.now();
  let snapshot = await createConfigIO({
    env,
    observe: false,
    pluginValidation: "skip",
  }).readConfigFileSnapshot();
  const selectedPlan =
    params.legacyConfigPlan?.snapshot.path === snapshot.path ? params.legacyConfigPlan : undefined;
  const requestedChannel = normalizeUpdateChannel(params.opts.channel);
  const storedChannel = normalizeUpdateChannel(
    (selectedPlan?.config ?? snapshot.config).update?.channel,
  );
  if (params.opts.channel) {
    await withOwnedManagedUpdateEnv(env, () =>
      withPluginLifecycleLease({}, async () => {
        if (selectedPlan) {
          snapshot = await maybeRepairLegacyConfigForUpdateChannel({
            configSnapshot: snapshot,
            plan: selectedPlan,
            jsonMode: Boolean(params.opts.json),
          });
        }
        if (!snapshot.valid) {
          throw new Error("Update refused: the selected configuration is still invalid.");
        }
        snapshot = await persistRequestedUpdateChannel({
          configSnapshot: snapshot,
          requestedChannel,
        });
      }),
    );
  }
  const records = await loadInstalledPluginIndexInstallRecords({ env });
  const missing = await collectMissingPluginInstallPayloads({
    records,
    config: snapshot.config,
    skipDisabledPlugins: true,
    env,
  });
  recordUpdateRunStep(
    run.runId,
    {
      step: "plugin convergence check",
      status: "completed",
      startedAtMs,
      endedAtMs: Date.now(),
      detail: missing.length
        ? `${missing.length} plugin payload(s) need repair; run openclaw update repair.`
        : "Installed plugin payloads are present.",
    },
    { env: run.env },
  );
  const selectedResult = { ...params.result };
  if (requestedChannel) {
    const configurationChanged = requestedChannel !== storedChannel || selectedPlan !== undefined;
    selectedResult.status = configurationChanged ? "ok" : "skipped";
    if (configurationChanged) {
      delete selectedResult.reason;
    } else {
      selectedResult.reason = "already-current";
    }
  }
  const result = completeUpdateCommandRun(selectedResult, run, 0);
  printResult(
    result,
    params.opts,
    missing.length ? { nextAction: "Run openclaw update repair to repair plugin payloads." } : {},
  );
}
