// CLI adapter for deterministic guarded replacement receipt reconciliation.
import { getRuntimeConfig } from "../config/config.js";
import {
  GuardedReplaceError,
  installGuardedReplaceReconcile,
  type GuardedReplaceReceipt,
  type ReconcileGuardedReplaceParams,
} from "../infra/install-guarded-replace.js";
import { resolveDefaultPluginExtensionsDir } from "../plugins/install-paths.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export type PluginReplaceGuardedReconcileOptions = { receipt: string };

export async function runPluginReplaceGuardedReconcileCommand(
  opts: PluginReplaceGuardedReconcileOptions,
  internals: {
    runtime?: RuntimeEnv;
    transaction?: Partial<
      Pick<ReconcileGuardedReplaceParams, "extensionsDir" | "stateDir" | "env" | "now">
    >;
  } = {},
): Promise<GuardedReplaceReceipt | undefined> {
  const runtime = internals.runtime ?? defaultRuntime;
  try {
    const receipt = await installGuardedReplaceReconcile({
      receiptPath: opts.receipt,
      config: getRuntimeConfig(),
      extensionsDir:
        internals.transaction?.extensionsDir ??
        resolveDefaultPluginExtensionsDir(internals.transaction?.env),
      ...internals.transaction,
    });
    runtime.log(JSON.stringify(receipt, null, 2));
    return receipt;
  } catch (error) {
    const code = error instanceof GuardedReplaceError ? error.code : "guarded_replace_failed";
    const message = error instanceof Error ? error.message : String(error);
    runtime.error(`${code}: ${message}`);
    runtime.exit(1);
    return undefined;
  }
}
