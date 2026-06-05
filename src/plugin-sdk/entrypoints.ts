// SDK entrypoint metadata lists supported public subpaths and deprecated barrel exports.
import deprecatedBarrelPluginSdkSubpathList from "../../scripts/lib/plugin-sdk-deprecated-barrel-subpaths.json" with { type: "json" };
import deprecatedPublicPluginSdkSubpathList from "../../scripts/lib/plugin-sdk-deprecated-public-subpaths.json" with { type: "json" };
import pluginSdkEntryList from "../../scripts/lib/plugin-sdk-entrypoints.json" with { type: "json" };
import privateLocalOnlyPluginSdkSubpathList from "../../scripts/lib/plugin-sdk-private-local-only-subpaths.json" with { type: "json" };

/** All declared SDK entrypoints, including public, deprecated, and local-only subpaths. */
export const pluginSdkEntrypoints = [...pluginSdkEntryList];

/** SDK subpaths without the root `openclaw/plugin-sdk` barrel entry. */
export const pluginSdkSubpaths = pluginSdkEntrypoints.filter((entry) => entry !== "index");

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
  (entry) => entry === "index" || !privateLocalOnlyPluginSdkSubpathSet.has(entry),
);

/** Published SDK subpaths, excluding the root barrel. */
export const publicPluginSdkSubpaths = publicPluginSdkEntrypoints.filter(
  (entry) => entry !== "index",
);

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
export const reservedBundledPluginSdkEntrypoints = ["codex-mcp-projection"] as const;

/**
 * Supported SDK facades backed by bundled plugins until generic contracts replace them.
 */
export const supportedBundledFacadeSdkEntrypoints = [
  "discord",
  "lmstudio",
  "lmstudio-runtime",
  "matrix",
  "mattermost",
  "memory-core-engine-runtime",
  "provider-zai-endpoint",
  "qa-runner-runtime",
  "telegram-account",
  "tts-runtime",
  "zalouser",
] as const;

/** Plugin-owned surfaces intentionally public and documented for third-party plugins. */
export const publicPluginOwnedSdkEntrypoints = [
  "browser-config",
  "image-generation-core",
  "memory-core",
  "memory-core-host-embedding-registry",
  "memory-core-host-engine-embeddings",
  "memory-core-host-engine-foundation",
  "memory-core-host-engine-qmd",
  "memory-core-host-engine-storage",
  "memory-core-host-events",
  "memory-core-host-multimodal",
  "memory-core-host-query",
  "memory-core-host-runtime-cli",
  "memory-core-host-runtime-core",
  "memory-core-host-runtime-files",
  "memory-core-host-secret",
  "memory-core-host-status",
  "memory-host-core",
  "memory-host-events",
  "memory-host-files",
  "memory-host-markdown",
  "memory-host-search",
  "memory-host-status",
  "speech-core",
  "telegram-command-config",
  "video-generation-core",
] as const;

/** Map every SDK entrypoint name to its source file path inside the repo. */
export function buildPluginSdkEntrySources(entries: readonly string[] = pluginSdkEntrypoints) {
  return Object.fromEntries(entries.map((entry) => [entry, `src/plugin-sdk/${entry}.ts`]));
}

/** List the public package specifiers that should resolve to plugin SDK entrypoints. */
export function buildPluginSdkSpecifiers() {
  return publicPluginSdkEntrypoints.map((entry) =>
    entry === "index" ? "openclaw/plugin-sdk" : `openclaw/plugin-sdk/${entry}`,
  );
}

/** Build the package.json exports map for public plugin SDK subpaths. */
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

/** List the dist artifacts expected for every generated plugin SDK entrypoint. */
export function listPluginSdkDistArtifacts() {
  return publicPluginSdkEntrypoints.flatMap((entry) => [
    `dist/plugin-sdk/${entry}.js`,
    `dist/plugin-sdk/${entry}.d.ts`,
  ]);
}
