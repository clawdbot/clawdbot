import type { PluginManifestRecord } from "./manifest-registry.js";

type SetupDescriptorRecord = Pick<PluginManifestRecord, "providers" | "cliBackends" | "setup">;

export function listSetupProviderIds(record: SetupDescriptorRecord): readonly string[] {
  return record.setup?.providers?.map((entry) => entry.id) ?? record.providers;
}

export function listSetupCliBackendIds(record: SetupDescriptorRecord): readonly string[] {
  return record.setup?.cliBackends ?? record.cliBackends;
}
