import { assertExperimentalClawsEnabled } from "../claws/experimental.js";
import { applyClawReconcileKeepLocal, planClawReconcile } from "../claws/reconcile.js";
// Experimental `claws reconcile` command: adopts locally modified managed
// state as the new owned content so drift stops blocking updates.
import { getRuntimeConfig } from "../config/config.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { ClawsReconcileOptions } from "./claws-cli.js";

export async function runClawsReconcileCommand(
  target: string,
  opts: ClawsReconcileOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  const config = getRuntimeConfig();
  const drift = await planClawReconcile(target, { config });
  if (!opts.keepLocal) {
    if (opts.json) {
      writeRuntimeJson(runtime, drift);
    } else {
      runtime.log("Experimental: Claws contracts may change while RFC 0016 is under review.");
      runtime.log(
        `Agent ${drift.agentId}: ${drift.agentDrifted ? "config drifted" : "config unchanged"}`,
      );
      runtime.log(`Drifted files: ${drift.files.length}`);
      for (const file of drift.files) {
        runtime.log(`  ${file.state} ${file.path}`);
      }
    }
    return;
  }
  const result = await applyClawReconcileKeepLocal(drift, { paths: opts.paths, config }, {});
  if (opts.json) {
    writeRuntimeJson(runtime, result);
    return;
  }
  runtime.log(`Adopted files: ${result.adoptedFiles.join(", ") || "(none)"}`);
  runtime.log(result.adoptedAgent ? "Adopted live agent config." : "Agent config left unchanged.");
}
