// Derives plugin SDK entrypoint sets, package exports, and dist artifact paths.
import deprecatedBarrelPluginSdkSubpathList from "./plugin-sdk-deprecated-barrel-subpaths.json" with { type: "json" };
import deprecatedPublicPluginSdkSubpathList from "./plugin-sdk-deprecated-public-subpaths.json" with { type: "json" };
import pluginSdkEntryList from "./plugin-sdk-entrypoints.json" with { type: "json" };
import privateLocalOnlyPluginSdkSubpathList from "./plugin-sdk-private-local-only-subpaths.json" with { type: "json" };

/**
 * All plugin SDK entrypoints, including the package root index.
 * @internal Shared repository-script contract.
 */
export const pluginSdkEntrypoints = [...pluginSdkEntryList];

/**
 * Plugin SDK subpath entrypoints, excluding the package root index.
 * @internal Shared test-configuration contract.
 */
export const pluginSdkSubpaths = pluginSdkEntrypoints.filter((entry) => entry !== "index");

const privateLocalOnlyPluginSdkSubpathSet = new Set(
  privateLocalOnlyPluginSdkSubpathList.filter(
    (entry) => typeof entry === "string" && !entry.includes("/"),
  ),
);

/**
 * Private plugin SDK entrypoints that are built locally but not exported publicly.
 * @internal Shared repository-script contract.
 */
export const privateLocalOnlyPluginSdkEntrypoints = pluginSdkSubpaths.filter((entry) =>
  privateLocalOnlyPluginSdkSubpathSet.has(entry),
);

/** Public plugin SDK entrypoints that appear in package exports. */
export const publicPluginSdkEntrypoints = pluginSdkEntrypoints.filter(
  (entry) => entry === "index" || !privateLocalOnlyPluginSdkSubpathSet.has(entry),
);

/**
 * Public plugin SDK subpaths, excluding the package root index.
 * @internal Shared repository-script contract.
 */
export const publicPluginSdkSubpaths = publicPluginSdkEntrypoints.filter(
  (entry) => entry !== "index",
);

/**
 * Deprecated public plugin SDK subpaths kept for compatibility.
 * @internal Shared repository-script contract.
 */
export const deprecatedPublicPluginSdkEntrypoints = publicPluginSdkSubpaths.filter((entry) =>
  deprecatedPublicPluginSdkSubpathList.includes(entry),
);

/**
 * Deprecated barrel entrypoints that should not be expanded further.
 * @internal Shared repository-script contract.
 */
export const deprecatedBarrelPluginSdkEntrypoints = pluginSdkSubpaths.filter((entry) =>
  deprecatedBarrelPluginSdkSubpathList.includes(entry),
);

/**
 * Build tsdown entry source paths for plugin SDK entrypoints.
 * @internal Shared repository-script contract.
 */
export function buildPluginSdkEntrySources(entries = pluginSdkEntrypoints) {
  return Object.fromEntries(entries.map((entry) => [entry, `src/plugin-sdk/${entry}.ts`]));
}

/**
 * Build package export metadata for public plugin SDK entrypoints.
 * @internal Shared repository-script contract.
 */
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

/**
 * List public plugin SDK dist artifacts expected in package output.
 * @internal Shared repository-script contract.
 */
export function listPluginSdkDistArtifacts() {
  return publicPluginSdkEntrypoints.flatMap((entry) => [
    `dist/plugin-sdk/${entry}.js`,
    `dist/plugin-sdk/${entry}.d.ts`,
  ]);
}

/**
 * List private local-only plugin SDK dist artifacts expected after local builds.
 * @internal Shared repository-script contract.
 */
export function listPrivateLocalOnlyPluginSdkDistArtifacts() {
  return privateLocalOnlyPluginSdkEntrypoints.flatMap((entry) => [
    `dist/plugin-sdk/${entry}.js`,
    `dist/plugin-sdk/${entry}.d.ts`,
  ]);
}
