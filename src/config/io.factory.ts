import { createConfigIoContext } from "./io.context.js";
import { loadConfigFromContext } from "./io.load.js";
import {
  promoteConfigSnapshotToLastKnownGoodCore,
  recoverConfigFromLastKnownGoodCore,
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
import type { writeConfigFileFromContext } from "./io.write.js";
import type { ConfigFileSnapshot } from "./types.js";

export function createConfigIO(options: ConfigIoFactoryOptions = {}) {
  const context = createConfigIoContext(options);
  const readInternal = () => readConfigFileSnapshotInternal(context);
  return {
    configPath: context.configPath,
    env: context.deps.env,
    logger: context.deps.logger,
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
      promoteConfigSnapshotToLastKnownGoodCore({
        deps: context.deps,
        snapshot,
        logger: context.deps.logger,
      }),
    recoverConfigFromLastKnownGood: (params: { snapshot: ConfigFileSnapshot; reason: string }) =>
      recoverConfigFromLastKnownGoodCore({
        deps: context.deps,
        snapshot: params.snapshot,
        reason: params.reason,
        prepareCandidate: context.prepareRecoveryBackupCandidate,
      }),
    recoverConfigFromJsonRootSuffix: (snapshot: ConfigFileSnapshot) =>
      recoverConfigFromJsonRootSuffixWithContext(context, snapshot),
    writeConfigFile: async (
      config: Parameters<typeof writeConfigFileFromContext>[1],
      writeOptions: Parameters<typeof writeConfigFileFromContext>[2] = {},
    ) => {
      const { writeConfigFileFromContext } = await import("./io.write.js");
      return writeConfigFileFromContext(context, config, writeOptions, readInternal);
    },
  };
}
