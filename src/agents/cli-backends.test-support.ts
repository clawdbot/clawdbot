import "./cli-backends.js";

type CliBackendsDeps = {
  resolvePluginSetupCliBackend: typeof import("../plugins/setup-registry.js").resolvePluginSetupCliBackend;
  resolvePluginSetupRegistry: typeof import("../plugins/setup-registry.js").resolvePluginSetupRegistry;
  resolveRuntimeCliBackends: typeof import("../plugins/cli-backends.runtime.js").resolveRuntimeCliBackends;
};

type CliBackendsTestApi = {
  resetDepsForTest(): void;
  setDepsForTest(deps: Partial<CliBackendsDeps>): void;
};

export const testing = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.cliBackendsTestApi")
] as CliBackendsTestApi;
