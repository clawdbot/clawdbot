// Captures source config and write ownership for administrative plugin mutations.
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshotForWrite,
} from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
  type ConfigSnapshotForInstallPersist,
} from "./install-config-mutation.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";

function assertValidConfigSnapshot(
  prepared: Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>,
): ConfigSnapshotForInstallPersist {
  const { snapshot, writeOptions } = prepared;
  if (!snapshot.valid) {
    throw new ManagedPluginLifecycleError(
      "Config invalid; run `openclaw doctor --fix` before managing plugins.",
    );
  }
  const mutationWriteOptions = selectInstallMutationWriteOptions(writeOptions);
  const { pluginMutation } = resolveInstallConfigMutationPreflights({
    parsed: asRecord(snapshot.parsed),
    snapshotPath: snapshot.path,
    writeOptions: mutationWriteOptions,
  });
  if (pluginMutation.mode === "blocked") {
    throw new ManagedPluginLifecycleError(pluginMutation.reason);
  }
  return {
    config: snapshot.sourceConfig,
    baseHash: snapshot.hash,
    writeOptions: mutationWriteOptions,
  };
}

export async function readPluginMutationSnapshot(
  env: NodeJS.ProcessEnv,
): Promise<ConfigSnapshotForInstallPersist> {
  try {
    assertConfigWriteAllowedInCurrentMode({ env });
  } catch (error) {
    throw new ManagedPluginLifecycleError(formatErrorMessage(error), { cause: error });
  }
  return assertValidConfigSnapshot(await readConfigFileSnapshotForWrite());
}
