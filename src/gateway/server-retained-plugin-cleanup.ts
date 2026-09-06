type RetainedPluginCleanupLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export async function cleanupRetainedPluginInstallGenerations(params: {
  log: RetainedPluginCleanupLogger;
  startupInstallPaths: Iterable<string>;
}): Promise<void> {
  try {
    const {
      clearLoadInstalledPluginIndexInstallRecordsCache,
      loadInstalledPluginIndexInstallRecordsSync,
    } = await import("../plugins/installed-plugin-index-records.js");
    // An external install may have advanced the ledger during the idle delay.
    // Protect both the desired install and the code still owned by this Gateway.
    clearLoadInstalledPluginIndexInstallRecordsCache();
    const records = loadInstalledPluginIndexInstallRecordsSync();
    const { cleanupRetainedManagedNpmInstallGenerations } =
      await import("../plugins/managed-npm-retention.js");
    const removedGenerations = await cleanupRetainedManagedNpmInstallGenerations({
      activeInstallPaths: [
        ...params.startupInstallPaths,
        ...Object.values(records).flatMap((record) =>
          record.installPath ? [record.installPath] : [],
        ),
      ],
      onError: (error, projectRoot) =>
        params.log.warn(`failed to clean retained npm generation ${projectRoot}: ${String(error)}`),
    });
    if (removedGenerations > 0) {
      params.log.info(`cleaned ${removedGenerations} retained npm plugin generation(s)`);
    }
  } catch (error) {
    params.log.warn(`retained npm generation cleanup unavailable: ${String(error)}`);
  }
}
