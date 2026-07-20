export const pluginSdkEntrypoints: string[];
export const pluginSdkSubpaths: string[];
export const privateLocalOnlyPluginSdkEntrypoints: string[];
export const productionPluginSdkEntrypoints: string[];
export const publicPluginSdkEntrypoints: string[];
export const publicPluginSdkSubpaths: string[];
export const deprecatedPublicPluginSdkEntrypoints: string[];
export const deprecatedBarrelPluginSdkEntrypoints: string[];

export function buildPluginSdkEntrySources(entries?: readonly string[]): Record<string, string>;
export function buildPluginSdkPackageExports(): Record<
  string,
  {
    types: string;
    default: string;
  }
>;
export function listPluginSdkDistArtifacts(): string[];
export function listPackagedPrivatePluginSdkRuntimeArtifacts(): string[];
export function listUnpackagedPrivatePluginSdkDistArtifacts(): string[];
