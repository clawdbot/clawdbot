type RetainedPluginCleanupLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export async function cleanupRetainedPluginInstallGenerations(params: {
  log: RetainedPluginCleanupLogger;
}): Promise<void> {
  try {
    // The idle delay spans plugin installs and reloads; protect the current paths,
    // not the startup snapshot, before deleting any retained generation.
    const records = (
      await import("../plugins/installed-plugin-index-records.js")
    ).loadInstalledPluginIndexInstallRecordsSync();
    const { cleanupRetainedManagedNpmInstallGenerations } =
      await import("../plugins/managed-npm-retention.js");
    const removedGenerations = await cleanupRetainedManagedNpmInstallGenerations({
      activeInstallPaths: Object.values(records).flatMap((record) =>
        record.installPath ? [record.installPath] : [],
      ),
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
