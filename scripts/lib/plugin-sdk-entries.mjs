import deprecatedBarrelPluginSdkSubpathList from "./plugin-sdk-deprecated-barrel-subpaths.json" with { type: "json" };
import deprecatedPublicPluginSdkSubpathList from "./plugin-sdk-deprecated-public-subpaths.json" with { type: "json" };
import pluginSdkEntryList from "./plugin-sdk-entrypoints.json" with { type: "json" };
import privateLocalOnlyPluginSdkSubpathList from "./plugin-sdk-private-local-only-subpaths.json" with { type: "json" };

export const pluginSdkEntrypoints = [...pluginSdkEntryList];

export const pluginSdkSubpaths = pluginSdkEntrypoints.filter((entry) => entry !== "index");

const privateLocalOnlyPluginSdkSubpathSet = new Set(
  privateLocalOnlyPluginSdkSubpathList.filter(
    (entry) => typeof entry === "string" && !entry.includes("/"),
  ),
);

export const privateLocalOnlyPluginSdkEntrypoints = pluginSdkSubpaths.filter((entry) =>
  privateLocalOnlyPluginSdkSubpathSet.has(entry),
);

export const publicPluginSdkEntrypoints = pluginSdkEntrypoints.filter(
  (entry) => entry === "index" || !privateLocalOnlyPluginSdkSubpathSet.has(entry),
);

export const publicPluginSdkSubpaths = publicPluginSdkEntrypoints.filter(
  (entry) => entry !== "index",
);

export const deprecatedPublicPluginSdkEntrypoints = publicPluginSdkSubpaths.filter((entry) =>
  deprecatedPublicPluginSdkSubpathList.includes(entry),
);

export const deprecatedBarrelPluginSdkEntrypoints = pluginSdkSubpaths.filter((entry) =>
  deprecatedBarrelPluginSdkSubpathList.includes(entry),
);

export function buildPluginSdkEntrySources() {
  return Object.fromEntries(
    pluginSdkEntrypoints.map((entry) => [entry, `src/plugin-sdk/${entry}.ts`]),
  );
}

export function buildPluginSdkPackageExports() {
  return Object.fromEntries(
    publicPluginSdkEntrypoints.map((entry) => [
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
