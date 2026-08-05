// CLI adapter for the receipt-backed guarded plugin replacement transaction.
import { getRuntimeConfig } from "../config/config.js";
import {
  GuardedReplaceError,
  installGuardedReplace,
  type GuardedReplaceReceipt,
  type InstallGuardedReplaceParams,
} from "../infra/install-guarded-replace.js";
import { resolveDefaultPluginExtensionsDir } from "../plugins/install-paths.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export type PluginReplaceGuardedOptions = {
  id: string;
  candidateSha256: string;
  expectedPredecessorSha256: string;
  rollbackArchive: string;
  rollbackSha256: string;
  receipt: string;
};

export async function runPluginReplaceGuardedCommand(
  candidateArchive: string,
  opts: PluginReplaceGuardedOptions,
  internals: {
    runtime?: RuntimeEnv;
    transaction?: Partial<
      Pick<
        InstallGuardedReplaceParams,
        "extensionsDir" | "stateDir" | "env" | "fault" | "now" | "createId"
      >
    >;
  } = {},
): Promise<GuardedReplaceReceipt | undefined> {
  const runtime = internals.runtime ?? defaultRuntime;
  try {
    const receipt = await installGuardedReplace({
      candidateArchive,
      candidateSha256: opts.candidateSha256,
      expectedPredecessorSha256: opts.expectedPredecessorSha256,
      pluginId: opts.id,
      receiptPath: opts.receipt,
      rollbackArchive: opts.rollbackArchive,
      rollbackSha256: opts.rollbackSha256,
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
