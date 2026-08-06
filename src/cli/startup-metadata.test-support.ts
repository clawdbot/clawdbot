import "./startup-metadata.js";

type CliStartupMetadataTestApi = {
  resolveStartupMetadataPathCandidates(moduleUrl: string): string[];
  clearStartupMetadataCache(): void;
};

function getTestApi(): CliStartupMetadataTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.cliStartupMetadataTestApi")
  ] as CliStartupMetadataTestApi;
}

export const testing = {
  resolveStartupMetadataPathCandidates(moduleUrl: string): string[] {
    return getTestApi().resolveStartupMetadataPathCandidates(moduleUrl);
  },
  clearStartupMetadataCache(): void {
    getTestApi().clearStartupMetadataCache();
  },
};
