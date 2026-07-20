// Derives plugin SDK entrypoint sets, package exports, and dist artifact paths.
import deprecatedBarrelPluginSdkSubpathList from "./plugin-sdk-deprecated-barrel-subpaths.json" with { type: "json" };
import deprecatedPublicPluginSdkSubpathList from "./plugin-sdk-deprecated-public-subpaths.json" with { type: "json" };
import pluginSdkEntryList from "./plugin-sdk-entrypoints.json" with { type: "json" };
import privateLocalOnlyPluginSdkSubpathList from "./plugin-sdk-private-local-only-subpaths.json" with { type: "json" };

/**
 * All plugin SDK subpath entrypoints. The package root barrel has been removed.
 * @internal Shared repository-script contract.
 */
export const pluginSdkEntrypoints = [...pluginSdkEntryList];

/**
 * Plugin SDK subpath entrypoints.
 * @internal Shared test-configuration contract.
 */
export const pluginSdkSubpaths = pluginSdkEntrypoints;

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
  (entry) => !privateLocalOnlyPluginSdkSubpathSet.has(entry),
);

/**
 * Public plugin SDK subpaths.
 * @internal Shared repository-script contract.
 */
export const publicPluginSdkSubpaths = publicPluginSdkEntrypoints;

// These local-only entries were already omitted from ordinary packaged builds
// before bundled runtime facades moved behind the same private-local boundary.
const nonProductionPluginSdkSubpathSet = new Set([
  "agent-runtime-test-contracts",
  "channel-contract-testing",
  "channel-target-testing",
  "channel-test-helpers",
  "codex-native-task-runtime",
  "plugin-test-api",
  "plugin-test-contracts",
  "plugin-state-test-runtime",
  "plugin-test-runtime",
  "provider-http-test-mocks",
  "provider-test-contracts",
  "qa-channel",
  "qa-channel-protocol",
  "qa-lab",
  "qa-runtime",
  "reply-payload-testing",
  "sqlite-runtime-testing",
  "ssrf-runtime-internal",
  "test-env",
  "test-fixtures",
  "test-live",
  "test-live-auth",
  "test-media-generation",
  "test-media-understanding",
  "test-node-mocks",
]);

/** Plugin SDK entrypoints built in ordinary source and packaged runtime builds. */
export const productionPluginSdkEntrypoints = pluginSdkEntrypoints.filter(
  (entry) => !nonProductionPluginSdkSubpathSet.has(entry),
);

const productionPluginSdkEntrypointSet = new Set(productionPluginSdkEntrypoints);

/** Private runtime facades required by core or bundled plugins in packaged builds. */
const packagedPrivatePluginSdkRuntimeEntrypoints = privateLocalOnlyPluginSdkEntrypoints.filter(
  (entry) => productionPluginSdkEntrypointSet.has(entry),
);

/** Private entrypoints reserved for local tests and QA builds. */
const nonProductionPrivatePluginSdkEntrypoints = privateLocalOnlyPluginSdkEntrypoints.filter(
  (entry) => !productionPluginSdkEntrypointSet.has(entry),
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
      `./plugin-sdk/${entry}`,
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
/** List private runtime facade artifacts required inside package output. */
export function listPackagedPrivatePluginSdkRuntimeArtifacts() {
  return packagedPrivatePluginSdkRuntimeEntrypoints.map((entry) => `dist/plugin-sdk/${entry}.js`);
}

/** List private artifacts that must stay out of package output. */
export function listUnpackagedPrivatePluginSdkDistArtifacts() {
  return [
    ...privateLocalOnlyPluginSdkEntrypoints.map((entry) => `dist/plugin-sdk/${entry}.d.ts`),
    ...nonProductionPrivatePluginSdkEntrypoints.map((entry) => `dist/plugin-sdk/${entry}.js`),
  ];
}
