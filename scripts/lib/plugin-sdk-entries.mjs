import pluginSdkEntryList from "./plugin-sdk-entrypoints.json" with { type: "json" };

export const pluginSdkEntrypoints = [...pluginSdkEntryList];

export const pluginSdkSubpaths = pluginSdkEntrypoints.filter((entry) => entry !== "index");

export function buildPluginSdkEntrySources() {
  return Object.fromEntries(
    pluginSdkEntrypoints.map((entry) => [entry, `src/plugin-sdk/${entry}.ts`]),
  );
}

export function buildPluginSdkPackageExports() {
  return Object.fromEntries(
    pluginSdkEntrypoints.map((entry) => [
      entry === "index" ? "./plugin-sdk" : `./plugin-sdk/${entry}`,
      {
        types: `./dist/plugin-sdk/${entry}.d.ts`,
        default: `./dist/plugin-sdk/${entry}.js`,
      },
    ]),
  );
}

export function listPluginSdkDistArtifacts() {
  return pluginSdkEntrypoints.flatMap((entry) => [
    `dist/plugin-sdk/${entry}.js`,
    `dist/plugin-sdk/${entry}.d.ts`,
  ]);
}
