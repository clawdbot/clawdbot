// SDK entrypoint metadata lists supported public subpaths and deprecated barrel exports.
import deprecatedBarrelPluginSdkSubpathList from "../../scripts/lib/plugin-sdk-deprecated-barrel-subpaths.json" with { type: "json" };
import deprecatedPublicPluginSdkSubpathList from "../../scripts/lib/plugin-sdk-deprecated-public-subpaths.json" with { type: "json" };
import pluginSdkEntryList from "../../scripts/lib/plugin-sdk-entrypoints.json" with { type: "json" };
import privateLocalOnlyPluginSdkSubpathList from "../../scripts/lib/plugin-sdk-private-local-only-subpaths.json" with { type: "json" };

/** All declared SDK subpath entrypoints, including public and local-only surfaces. */
export const pluginSdkEntrypoints = [...pluginSdkEntryList];

/** All SDK subpaths; the removed package root is intentionally absent. */
export const pluginSdkSubpaths = pluginSdkEntrypoints;

const privateLocalOnlyPluginSdkSubpathSet = new Set<string>(
  privateLocalOnlyPluginSdkSubpathList.filter(
    (entry): entry is string => typeof entry === "string" && !entry.includes("/"),
  ),
);

/** Entrypoints reserved for local repo/runtime checks and excluded from package exports. */
export const privateLocalOnlyPluginSdkEntrypoints = pluginSdkSubpaths.filter((entry) =>
  privateLocalOnlyPluginSdkSubpathSet.has(entry),
);

/** Entrypoints exported by the published package for third-party plugin imports. */
export const publicPluginSdkEntrypoints = pluginSdkEntrypoints.filter(
  (entry) => !privateLocalOnlyPluginSdkSubpathSet.has(entry),
);

/** Published SDK subpaths. */
export const publicPluginSdkSubpaths = publicPluginSdkEntrypoints;

/** Public SDK subpaths that remain importable but are marked deprecated in docs/contracts. */
export const deprecatedPublicPluginSdkEntrypoints = publicPluginSdkSubpaths.filter((entry) =>
  deprecatedPublicPluginSdkSubpathList.includes(entry),
);

/** Deprecated subpaths still re-exported by the root SDK barrel for compatibility. */
export const deprecatedBarrelPluginSdkEntrypoints = pluginSdkSubpaths.filter((entry) =>
  deprecatedBarrelPluginSdkSubpathList.includes(entry),
);

/**
 * Transitional compatibility/helper surfaces owned by their matching bundled plugin.
 *
 * Cross-owner extension imports are blocked by package contract guardrails.
 */
export const reservedBundledPluginSdkEntrypoints = [] as const;

/**
 * Supported SDK facades backed by bundled plugins until generic contracts replace them.
 */
export const supportedBundledFacadeSdkEntrypoints = [
  "discord",
  "matrix",
  "telegram-account",
] as const;

/** Plugin-owned surfaces intentionally public and documented for third-party plugins. */
export const publicPluginOwnedSdkEntrypoints = ["memory-core-host-engine-foundation"] as const;

/** Map every SDK entrypoint name to its source file path inside the repo. */
export function buildPluginSdkEntrySources(entries: readonly string[] = pluginSdkEntrypoints) {
  return Object.fromEntries(entries.map((entry) => [entry, `src/plugin-sdk/${entry}.ts`]));
}

/** Build the package.json exports map for public plugin SDK subpaths. */
export function buildPluginSdkPackageExports() {
  return Object.fromEntries(
    publicPluginSdkEntrypoints.map((entry) => [
      `./plugin-sdk/${entry}`,
      {
        types: `./dist/plugin-sdk/${entry}.d.ts`,
        default: `./dist/plugin-sdk/${entry}.js`,
      },
    ]),
  );
}

/** List the dist artifacts expected for every generated plugin SDK entrypoint. */
export function listPluginSdkDistArtifacts() {
  return publicPluginSdkEntrypoints.flatMap((entry) => [
    `dist/plugin-sdk/${entry}.js`,
    `dist/plugin-sdk/${entry}.d.ts`,
  ]);
}
