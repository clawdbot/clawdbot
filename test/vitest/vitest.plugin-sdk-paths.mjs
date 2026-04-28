const normalizeRepoPath = (value) => value.replaceAll("\\", "/");

const pluginSdkLightEntries = [
  { source: "src/plugin-sdk/acp-runtime.ts", test: "src/plugin-sdk/acp-runtime.test.ts" },
  { source: "src/plugin-sdk/allow-from.ts", test: "src/plugin-sdk/allow-from.test.ts" },
  {
    source: "src/plugin-sdk/keyed-async-queue.ts",
    test: "src/plugin-sdk/keyed-async-queue.test.ts",
  },
  { source: "src/plugin-sdk/lazy-value.ts", test: "src/plugin-sdk/lazy-value.test.ts" },
  {
    source: "src/plugin-sdk/memory-host-events.ts",
    test: "src/plugin-sdk/memory-host-events.test.ts",
  },
  {
    source: "src/plugin-sdk/persistent-dedupe.ts",
    test: "src/plugin-sdk/memory-host-events.test.ts",
  },
  { source: "src/plugin-sdk/provider-entry.ts", test: "src/plugin-sdk/provider-entry.test.ts" },
  {
    source: "src/plugin-sdk/provider-model-shared.ts",
    test: "src/plugin-sdk/provider-model-shared.test.ts",
  },
  { source: "src/plugin-sdk/provider-tools.ts", test: "src/plugin-sdk/provider-tools.test.ts" },
  {
    source: "src/plugin-sdk/status-helpers.ts",
    test: "src/plugin-sdk/status-helpers.test.ts",
  },
  { source: "src/plugin-sdk/temp-path.ts", test: "src/plugin-sdk/temp-path.test.ts" },
  {
    source: "src/plugin-sdk/text-chunking.ts",
    test: "src/plugin-sdk/text-chunking.test.ts",
  },
  {
    source: "src/plugin-sdk/webhook-targets.ts",
    test: "src/plugin-sdk/webhook-targets.test.ts",
  },
];

const pluginSdkLightIncludePatternByFile = new Map(
  pluginSdkLightEntries.flatMap(({ source, test }) => [
    [source, test],
    [test, test],
  ]),
);

export const pluginSdkLightSourceFiles = pluginSdkLightEntries.map(({ source }) => source);
export const pluginSdkLightTestFiles = pluginSdkLightEntries.map(({ test }) => test);

export function isPluginSdkLightTarget(file) {
  return pluginSdkLightIncludePatternByFile.has(normalizeRepoPath(file));
}

export function isPluginSdkLightTestFile(file) {
  return pluginSdkLightTestFiles.includes(normalizeRepoPath(file));
}

export function resolvePluginSdkLightIncludePattern(file) {
  return pluginSdkLightIncludePatternByFile.get(normalizeRepoPath(file)) ?? null;
}
