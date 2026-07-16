import "./plugin-dependency-cleanup.js";

type TestApi = {
  collectLegacyPluginDependencyTargets(
    env?: NodeJS.ProcessEnv,
    options?: { packageRoot?: string | null },
  ): Promise<string[]>;
};

function getTestApi(): TestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.pluginDependencyCleanupTestApi")
  ] as TestApi;
}

export const collectLegacyPluginDependencyTargets: TestApi["collectLegacyPluginDependencyTargets"] =
  (env, options) => getTestApi().collectLegacyPluginDependencyTargets(env, options);
