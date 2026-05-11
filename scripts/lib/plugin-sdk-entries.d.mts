export const pluginSdkEntrypoints: string[];
export const pluginSdkSubpaths: string[];
export const privateLocalOnlyPluginSdkEntrypoints: string[];
export const publicPluginSdkEntrypoints: string[];
export const publicPluginSdkSubpaths: string[];
export const deprecatedPublicPluginSdkEntrypoints: string[];
export const deprecatedBarrelPluginSdkEntrypoints: string[];

export function buildPluginSdkEntrySources(): Record<string, string>;
export function buildPluginSdkPackageExports(): Record<
  string,
  {
    types: string;
    default: string;
  }
>;
export function listPluginSdkDistArtifacts(): string[];
