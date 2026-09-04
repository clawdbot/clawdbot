type StateCoordinatorModule = typeof import("../../src/infra/state-database-coordinator.js");

/** Keep real locking and error identities while routing fixture I/O away from shared runtime paths. */
export function createIsolatedStateCoordinator(
  actual: StateCoordinatorModule,
  resolveRuntimeDirectory: () => string | undefined,
): StateCoordinatorModule {
  const runtimeDirectory = () => {
    const directory = resolveRuntimeDirectory();
    if (!directory) {
      throw new Error("State coordinator fixture is not initialized");
    }
    return directory;
  };
  return {
    ...actual,
    resolveStateLifecycleRuntimeDirectory: runtimeDirectory,
    acquireGatewayLifecycleCoordinator: (
      params: Parameters<typeof actual.acquireGatewayLifecycleCoordinator>[0],
    ) =>
      actual.acquireGatewayLifecycleCoordinator({
        ...params,
        runtimeDirectory: runtimeDirectory(),
      }),
    acquireStateDatabaseCoordinator: (
      params: Parameters<typeof actual.acquireStateDatabaseCoordinator>[0],
    ) =>
      actual.acquireStateDatabaseCoordinator({ ...params, runtimeDirectory: runtimeDirectory() }),
    withStateSchemaFence: <T>(
      params: Parameters<typeof actual.withStateSchemaFence>[0],
      operation: () => T,
    ) =>
      actual.withStateSchemaFence({ ...params, runtimeDirectory: runtimeDirectory() }, operation),
  };
}
