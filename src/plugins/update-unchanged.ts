import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { buildNpmResolutionInstallFields, resolveNpmInstallRecordSpec } from "./installs.js";
import { formatNewerExactPinnedNpmDefaultLineMessage } from "./update-attempt.js";
import {
  resolveNewerExactPinnedNpmDefaultLine,
  type PluginUpdateOutcome,
  type UpdatablePluginInstallRecord,
} from "./update-source.js";

export async function reconcileUnchangedUpdate(params: {
  config: OpenClawConfig;
  pluginId: string;
  record: UpdatablePluginInstallRecord;
  currentVersion: string;
  recordSpec?: string;
  resolution: NpmSpecResolution;
  updateChannel?: UpdateChannel;
  timeoutMs?: number;
  hasSpecOverride: boolean;
  hasOfficialNpmSpec: boolean;
  syncOfficialInstall: boolean;
  preserveRecordIntent: boolean;
}): Promise<{ config: OpenClawConfig; changed: boolean; outcome: PluginUpdateOutcome }> {
  const newerExactPinnedDefaultLine =
    !params.hasSpecOverride && !params.hasOfficialNpmSpec
      ? await resolveNewerExactPinnedNpmDefaultLine({
          currentVersion: params.currentVersion,
          recordedSpec: params.record.spec,
          probeNpmVersion: params.resolution.version,
          updateChannel: params.updateChannel,
          timeoutMs: params.timeoutMs,
        })
      : undefined;

  let config = params.config;
  let changed = false;
  if (params.syncOfficialInstall) {
    const nextRecordSpec = resolveNpmInstallRecordSpec({
      requestedSpec: params.recordSpec,
      resolution: params.resolution,
      pinResolvedRegistrySpec: !params.preserveRecordIntent,
    });
    if (nextRecordSpec !== params.record.spec) {
      const resolutionFields = buildNpmResolutionInstallFields(params.resolution);
      config = {
        ...config,
        plugins: {
          ...config.plugins,
          installs: {
            ...config.plugins?.installs,
            [params.pluginId]: {
              ...params.record,
              spec: nextRecordSpec,
              resolvedName: resolutionFields.resolvedName ?? params.record.resolvedName,
              resolvedVersion: resolutionFields.resolvedVersion ?? params.record.resolvedVersion,
              resolvedSpec: resolutionFields.resolvedSpec ?? params.record.resolvedSpec,
              integrity: resolutionFields.integrity ?? params.record.integrity,
              shasum: resolutionFields.shasum ?? params.record.shasum,
              resolvedAt: resolutionFields.resolvedAt ?? params.record.resolvedAt,
            },
          },
        },
      };
      changed = true;
    }
  }

  return {
    config,
    changed,
    outcome: {
      pluginId: params.pluginId,
      status: "unchanged",
      currentVersion: params.currentVersion,
      nextVersion: newerExactPinnedDefaultLine?.version ?? params.resolution.version,
      message:
        newerExactPinnedDefaultLine && params.record.spec
          ? formatNewerExactPinnedNpmDefaultLineMessage({
              pluginId: params.pluginId,
              recordedSpec: params.record.spec,
              currentVersion: params.currentVersion,
              newer: newerExactPinnedDefaultLine,
            })
          : `${params.pluginId} is up to date (${params.currentVersion}).`,
    },
  };
}
