import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import {
  channelPluginIdBelongsToManifest,
  resolveSetupChannelRegistration,
} from "../../plugins/loader-channel-setup.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import {
  getCachedPluginModuleLoader,
  preparePluginModule,
} from "../../plugins/plugin-module-loader-cache.js";
import type { ChannelPlugin } from "./types.plugin.js";

const log = createSubsystemLogger("channels");

export type ChannelSetupPluginLoadFailure = {
  channelId: string;
  pluginId: string;
  message: string;
  source?: string;
};

export function loadSetupChannelPluginFromManifestRecord(params: {
  record: PluginManifestRecord;
  channelId: string;
  env: NodeJS.ProcessEnv;
}): { plugin?: ChannelPlugin; failure?: ChannelSetupPluginLoadFailure } {
  if (!params.record.setupSource || !params.record.channels.includes(params.channelId)) {
    return {};
  }
  try {
    const { modulePath } = preparePluginModule({
      modulePath: params.record.setupSource,
      boundaryRoot: params.record.rootDir,
      boundaryLabel: "plugin root",
      surfaceLabel: `channel setup entry ${params.record.id}`,
      rejectHardlinks: shouldRejectHardlinkedPluginFiles({
        origin: params.record.origin,
        rootDir: params.record.rootDir,
        env: params.env,
      }),
    });
    const moduleLoader = getCachedPluginModuleLoader({
      modulePath,
      rootDir: params.record.rootDir,
      importerUrl: import.meta.url,
      preferBuiltDist: true,
      loaderFilename: import.meta.url,
      tryNative: true,
      cacheScopeKey: "read-only-setup-entry",
    });
    const registration = resolveSetupChannelRegistration(moduleLoader(modulePath));
    if (registration.loadError) {
      return {
        failure: {
          channelId: params.channelId,
          pluginId: params.record.id,
          source: params.record.setupSource,
          message: `failed to load setup entry: ${formatErrorMessage(registration.loadError)}`,
        },
      };
    }
    if (!registration.plugin) {
      return {};
    }
    if (
      !channelPluginIdBelongsToManifest({
        channelId: registration.plugin.id,
        pluginId: params.record.id,
        manifestChannels: params.record.channels,
      })
    ) {
      return {};
    }
    return { plugin: registration.plugin };
  } catch (error) {
    const detail = formatErrorMessage(error);
    log.warn(`[channels] failed to load channel setup ${params.record.id}: ${detail}`);
    return {
      failure: {
        channelId: params.channelId,
        pluginId: params.record.id,
        source: params.record.setupSource,
        message: `failed to load setup entry: ${detail}`,
      },
    };
  }
}
