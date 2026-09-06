import { createConfigIO } from "../../config/io.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { collectMissingPluginInstallPayloads } from "../../plugins/payload-verification.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { printResult } from "./progress.js";
import type { UpdateCommandOptions } from "./shared.js";
import { persistRequestedUpdateChannel } from "./update-command-config.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { completeUpdateCommandRun } from "./update-command-run.js";

/** A same-version request inspects payloads without running repair or touching the service. */
export async function finishAlreadyCurrentUpdate(params: {
  opts: UpdateCommandOptions;
  result: UpdateRunResult;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const run = params.opts.run!;
  const env = params.env ?? run.env;
  const startedAtMs = Date.now();
  const snapshot = await createConfigIO({
    env,
    observe: false,
    pluginValidation: "skip",
  }).readConfigFileSnapshot();
  if (params.opts.channel) {
    await withOwnedManagedUpdateEnv(env, () =>
      withPluginLifecycleLease({}, async () => {
        await persistRequestedUpdateChannel({
          configSnapshot: snapshot,
          requestedChannel: normalizeUpdateChannel(params.opts.channel),
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
  const result = completeUpdateCommandRun(params.result, run, 0);
  printResult(
    result,
    params.opts,
    missing.length ? { nextAction: "Run openclaw update repair to repair plugin payloads." } : {},
  );
}
