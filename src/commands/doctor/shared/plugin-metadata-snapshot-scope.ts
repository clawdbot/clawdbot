import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginMetadataSnapshotScopeRunner } from "../../../plugins/current-plugin-metadata-snapshot.js";
import {
  createPluginMetadataOwner,
  withPluginMetadataCollectionScope,
  type PreparedPluginMetadata,
} from "../../../plugins/plugin-metadata-collection.js";

export type DoctorPluginMetadataState = {
  current?: PreparedPluginMetadata;
};

type DoctorPluginMetadataSnapshotScope = {
  run: PluginMetadataSnapshotScopeRunner;
  invalidate: () => void;
};

/** Owns fresh Doctor inventories without publishing over the running Gateway. */
export function createDoctorPluginMetadataSnapshotScope(params: {
  getBaseMetadata: () => PreparedPluginMetadata | undefined;
  env?: NodeJS.ProcessEnv;
}): DoctorPluginMetadataSnapshotScope {
  const env = params.env ?? process.env;
  const owner = createPluginMetadataOwner();
  const readBaseMetadata = params.getBaseMetadata;
  let currentBaseMetadata = readBaseMetadata();
  let seed = currentBaseMetadata;
  let forceFresh = false;

  const prepare = (config: OpenClawConfig, workspaceDir: string | undefined) => {
    const nextBaseMetadata = readBaseMetadata();
    if (nextBaseMetadata !== currentBaseMetadata) {
      owner.invalidatePreparation();
      currentBaseMetadata = nextBaseMetadata;
      seed = nextBaseMetadata;
    }
    const metadata = owner.prepare({ config, env, workspaceDir, seed, allowCurrent: !forceFresh });
    forceFresh = false;
    return metadata;
  };
  const run: PluginMetadataSnapshotScopeRunner = (scope, operation) =>
    withPluginMetadataCollectionScope(prepare(scope.config, scope.workspaceDir), operation, {
      config: scope.config,
      env,
      ...(scope.workspaceDir !== undefined ? { workspaceDir: scope.workspaceDir } : {}),
    });

  return {
    run,
    invalidate: () => {
      // Ignore the old seed until its owner supplies a replacement. Filesystem
      // repairs must not reconstruct a fresh generation from pre-repair records.
      owner.invalidatePreparation();
      currentBaseMetadata = readBaseMetadata();
      seed = undefined;
      forceFresh = true;
    },
  };
}
