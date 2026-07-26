import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import "./update-command-plugins.js";

type MissingPluginInstallPayload = {
  pluginId: string;
  installPath?: string;
  reason: "missing-install-path" | "missing-package-dir" | "missing-package-json";
};

type UpdateCommandPluginsTestApi = {
  buildInvalidConfigPostCoreUpdateResult(): {
    message: string;
    guidance: string[];
    result: PostCorePluginUpdateResult;
  };
  collectMissingPluginInstallPayloads(params: {
    records: Record<string, PluginInstallRecord>;
    config?: OpenClawConfig;
    skipDisabledPlugins?: boolean;
    syncOfficialPluginInstalls?: boolean;
    env?: NodeJS.ProcessEnv;
  }): Promise<MissingPluginInstallPayload[]>;
  resolvePostSyncPluginUpdateSkipIds(params: {
    switchedToClawHub: readonly string[];
    switchedToNpm: readonly string[];
    repairedMissingPayloadIds: ReadonlySet<string>;
  }): Set<string>;
};

function getTestApi(): UpdateCommandPluginsTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.updateCommandPluginsTestApi")
  ] as UpdateCommandPluginsTestApi;
}

export function buildInvalidConfigPostCoreUpdateResult() {
  return getTestApi().buildInvalidConfigPostCoreUpdateResult();
}

export async function collectMissingPluginInstallPayloads(
  params: Parameters<UpdateCommandPluginsTestApi["collectMissingPluginInstallPayloads"]>[0],
): Promise<MissingPluginInstallPayload[]> {
  return await getTestApi().collectMissingPluginInstallPayloads(params);
}

export function resolvePostSyncPluginUpdateSkipIds(
  params: Parameters<UpdateCommandPluginsTestApi["resolvePostSyncPluginUpdateSkipIds"]>[0],
): Set<string> {
  return getTestApi().resolvePostSyncPluginUpdateSkipIds(params);
}
