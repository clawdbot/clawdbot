import { createConfigIoContext } from "./io.context.js";
import { loadConfigFromContext } from "./io.load.js";
import {
  preserveConfigSnapshotAsClobbered,
  promoteConfigSnapshotToLastKnownGood,
  recoverConfigFromLastKnownGood,
} from "./io.observe-recovery.js";
import { recoverConfigFromJsonRootSuffixWithContext } from "./io.recovery.js";
import {
  readBestEffortConfigSnapshotFromContext,
  readConfigFileSnapshotForWriteFromContext,
  readConfigFileSnapshotFromContext,
  readConfigFileSnapshotInternal,
  readConfigFileSnapshotWithPluginMetadataFromContext,
  readSourceConfigBestEffortFromContext,
} from "./io.snapshot.js";
import type { ConfigIoFactoryOptions, ConfigSnapshotReadOptions } from "./io.types.js";
import { writeConfigFileFromContext } from "./io.write.js";
import type { ConfigFileSnapshot } from "./types.js";

export function createConfigIO(options: ConfigIoFactoryOptions = {}) {
  const context = createConfigIoContext(options);
  const readInternal = () => readConfigFileSnapshotInternal(context);
  return {
    configPath: context.configPath,
    env: context.deps.env,
    loadConfig: (loadOptions?: { skipSuspiciousRecovery?: boolean }) =>
      loadConfigFromContext(context, loadOptions),
    readBestEffortConfig: async () =>
      (await readBestEffortConfigSnapshotFromContext(context)).config,
    readBestEffortConfigSnapshot: () => readBestEffortConfigSnapshotFromContext(context),
    readSourceConfigBestEffort: () => readSourceConfigBestEffortFromContext(context),
    readConfigFileSnapshot: (readOptions: ConfigSnapshotReadOptions = {}) =>
      readConfigFileSnapshotFromContext(context, readOptions),
    readConfigFileSnapshotWithPluginMetadata: (readOptions: ConfigSnapshotReadOptions = {}) =>
      readConfigFileSnapshotWithPluginMetadataFromContext(context, readOptions),
    readConfigFileSnapshotForWrite: () => readConfigFileSnapshotForWriteFromContext(context),
    promoteConfigSnapshotToLastKnownGood: (snapshot: ConfigFileSnapshot) =>
      promoteConfigSnapshotToLastKnownGood({
        deps: context.deps,
        snapshot,
        logger: context.deps.logger,
      }),
    recoverConfigFromLastKnownGood: (params: { snapshot: ConfigFileSnapshot; reason: string }) =>
      recoverConfigFromLastKnownGood({
        deps: context.deps,
        snapshot: params.snapshot,
        reason: params.reason,
      }),
    preserveConfigSnapshotAsClobbered: (snapshot: ConfigFileSnapshot) =>
      preserveConfigSnapshotAsClobbered({ deps: context.deps, snapshot }),
    recoverConfigFromJsonRootSuffix: (snapshot: ConfigFileSnapshot) =>
      recoverConfigFromJsonRootSuffixWithContext(context, snapshot),
    writeConfigFile: (
      config: Parameters<typeof writeConfigFileFromContext>[1],
      writeOptions: Parameters<typeof writeConfigFileFromContext>[2] = {},
    ) => writeConfigFileFromContext(context, config, writeOptions, readInternal),
  };
}
