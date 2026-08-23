import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  withPluginMetadataSnapshotScope,
  type PluginMetadataSnapshotScopeRunner,
} from "../../../plugins/current-plugin-metadata-snapshot.js";
import {
  completePluginMetadataSnapshot,
  isPluginMetadataSnapshotCompatible,
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../../../plugins/plugin-metadata-snapshot.js";

export type DoctorPluginMetadataSnapshotState = {
  current?: PluginMetadataSnapshot;
};

type DoctorPluginMetadataSnapshotScope = {
  run: PluginMetadataSnapshotScopeRunner;
  invalidate: () => void;
};

/** Promotes validation-scoped metadata to a complete immutable Doctor snapshot. */
export function completeDoctorPluginMetadataSnapshot(params: {
  snapshot?: PluginMetadataSnapshot;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): PluginMetadataSnapshot | undefined {
  return completePluginMetadataSnapshot(params);
}

/** Reuses one exact immutable plugin metadata generation per Doctor workspace. */
export function createDoctorPluginMetadataSnapshotScope(params: {
  baseSnapshot?: PluginMetadataSnapshot;
  getBaseSnapshot?: () => PluginMetadataSnapshot | undefined;
  env?: NodeJS.ProcessEnv;
}): DoctorPluginMetadataSnapshotScope {
  const env = params.env ?? process.env;
  const snapshotsByWorkspace = new Map<string | undefined, PluginMetadataSnapshot>();
  const readBaseSnapshot = () => params.getBaseSnapshot?.() ?? params.baseSnapshot;
  let currentBaseSnapshot: PluginMetadataSnapshot | undefined;

  const refreshBaseSnapshot = () => {
    const nextBaseSnapshot = readBaseSnapshot();
    if (nextBaseSnapshot === currentBaseSnapshot) {
      return;
    }
    currentBaseSnapshot = nextBaseSnapshot;
    snapshotsByWorkspace.clear();
    if (nextBaseSnapshot && nextBaseSnapshot.pluginIds === undefined) {
      snapshotsByWorkspace.set(nextBaseSnapshot.workspaceDir, nextBaseSnapshot);
    }
  };

  const resolveSnapshot = (config: OpenClawConfig, workspaceDir: string | undefined) => {
    refreshBaseSnapshot();
    const current = snapshotsByWorkspace.get(workspaceDir);
    if (
      current &&
      isPluginMetadataSnapshotCompatible({
        snapshot: current,
        config,
        env,
        workspaceDir,
      })
    ) {
      return current;
    }
    const snapshot = loadPluginMetadataSnapshot({
      config,
      env,
      ...(workspaceDir ? { workspaceDir } : {}),
    });
    snapshotsByWorkspace.set(workspaceDir, snapshot);
    return snapshot;
  };

  const run: PluginMetadataSnapshotScopeRunner = (scope, operation) => {
    const snapshot = resolveSnapshot(scope.config, scope.workspaceDir);
    return withPluginMetadataSnapshotScope(snapshot, operation, {
      config: scope.config,
      env,
      ...(scope.workspaceDir ? { workspaceDir: scope.workspaceDir } : {}),
    });
  };

  return {
    run,
    invalidate: () => {
      // Inventory repairs invalidate every derived workspace generation even
      // when updater preflight intentionally left the base snapshot absent.
      currentBaseSnapshot = undefined;
      snapshotsByWorkspace.clear();
    },
  };
}
