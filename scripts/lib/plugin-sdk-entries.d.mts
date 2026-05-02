export const pluginSdkEntrypoints: string[];
export const pluginSdkSubpaths: string[];

export function buildPluginSdkEntrySources(): Record<string, string>;
export function buildPluginSdkPackageExports(): Record<
  string,
  {
    types: string;
    default: string;
  }
>;
export function listPluginSdkDistArtifacts(): string[];
