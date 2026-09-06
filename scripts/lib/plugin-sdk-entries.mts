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
 * Private plugin SDK entrypoints excluded from the typed, documented public API.
 * @internal Shared repository-script contract.
 */
export const privateLocalOnlyPluginSdkEntrypoints = pluginSdkSubpaths.filter((entry) =>
  privateLocalOnlyPluginSdkSubpathSet.has(entry),
);

/** Typed public plugin SDK entrypoints. */
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
  "channel-ingress-test-runtime",
  "channel-target-testing",
  "channel-test-helpers",
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
  "test-env",
  "test-fixtures",
  "test-live",
  "test-live-auth",
  "test-media-generation",
  "test-media-understanding",
  "test-node-mocks",
  "test-state",
]);

/** Plugin SDK entrypoints built in ordinary source and packaged runtime builds. */
export const productionPluginSdkEntrypoints = pluginSdkEntrypoints.filter(
  (entry) => !nonProductionPluginSdkSubpathSet.has(entry),
);

const productionPluginSdkEntrypointSet = new Set(productionPluginSdkEntrypoints);

/** Private runtime facades required by bundled or separately published official plugins. */
export const packagedPrivatePluginSdkRuntimeEntrypoints =
  privateLocalOnlyPluginSdkEntrypoints.filter((entry) =>
    productionPluginSdkEntrypointSet.has(entry),
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

/** Supported SDK facades backed by bundled plugins until generic contracts replace them. */
export const supportedBundledFacadeSdkEntrypoints = ["discord", "telegram-account"] as const;

/** Plugin-owned surfaces intentionally public and documented for third-party plugins. */
export const publicPluginOwnedSdkEntrypoints = ["memory-core-host-engine-foundation"] as const;

/**
 * Build tsdown entry source paths for plugin SDK entrypoints.
 * @internal Shared repository-script contract.
 */
export function buildPluginSdkEntrySources(entries: readonly string[] = pluginSdkEntrypoints) {
  return Object.fromEntries(entries.map((entry) => [entry, `src/plugin-sdk/${entry}.ts`]));
}

/**
 * Build package export metadata for typed public SDK and official plugin runtime entrypoints.
 * @internal Shared repository-script contract.
 */
export function buildPluginSdkPackageExports() {
  return Object.fromEntries(
    pluginSdkEntrypoints.flatMap((entry) => {
      if (publicPluginSdkEntrypoints.includes(entry)) {
        return [
          [
            `./plugin-sdk/${entry}`,
            {
              types: `./dist/plugin-sdk/${entry}.d.ts`,
              default: `./dist/plugin-sdk/${entry}.js`,
            },
          ],
        ];
      }
      if (packagedPrivatePluginSdkRuntimeEntrypoints.includes(entry)) {
        // Official plugins ship separately but execute against the host's private runtime.
        // Their declarations stay pack-excluded by listUnpackagedPrivatePluginSdkDistArtifacts.
        return [
          [
            `./plugin-sdk/${entry}`,
            {
              default: `./dist/plugin-sdk/${entry}.js`,
            },
          ],
        ];
      }
      return [];
    }),
  );
}

/** List private artifacts that must stay out of package output. */
export function listUnpackagedPrivatePluginSdkDistArtifacts(
  entries: readonly string[] = pluginSdkEntrypoints,
  privateEntries: readonly string[] = privateLocalOnlyPluginSdkEntrypoints,
) {
  const privateSet = new Set(privateEntries);
  const privateEntrypoints = entries.filter((entry) => privateSet.has(entry));
  return [
    ...privateEntrypoints.map((entry) => `dist/plugin-sdk/${entry}.d.ts`),
    ...privateEntrypoints
      .filter((entry) => nonProductionPluginSdkSubpathSet.has(entry))
      .map((entry) => `dist/plugin-sdk/${entry}.js`),
  ];
}
