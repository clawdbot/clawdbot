import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  createManagedPluginArtifactConsentHandler,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import type { PluginInstallArtifactConsentHandler } from "./install-types.js";

export function preparePluginUpdateCapabilityConsent(params: {
  config: OpenClawConfig;
  pluginId: string;
  record: PluginInstallRecord;
  installPath: string;
  packagePluginIds?: readonly string[];
  expectedIntegrity?: string;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  beforePersistentEffect?: () => void | Promise<void>;
}): {
  onBeforePluginArtifactCommit: PluginInstallArtifactConsentHandler;
  acceptInstallRecord: <T extends PluginInstallRecord>(record: T) => T;
} {
  const consent = createManagedPluginArtifactConsentHandler({
    config: params.config,
    source: params.record.source,
    spec: params.record.spec,
    expectedIntegrity: params.expectedIntegrity,
    previousRecords: {
      [params.pluginId]: { ...params.record, installPath: params.installPath },
    },
    updatingPluginIds: params.packagePluginIds ?? [],
    onCapabilityConsent: params.onCapabilityConsent,
    beforePersistentEffect: params.beforePersistentEffect,
  });
  let reviewedPluginId = params.pluginId;
  return {
    onBeforePluginArtifactCommit: async (artifact) => {
      reviewedPluginId = artifact.pluginId;
      await consent.onBeforePluginArtifactCommit({
        ...artifact,
        // New npm generations still inherit configured paths from the old package root.
        currentArtifactDir: params.installPath,
        mode: "update",
      });
    },
    acceptInstallRecord: (record) => consent.applyAcceptedSurface(reviewedPluginId, record),
  };
}
