import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import "./doctor-vector-index-provider.js";

type TestApi = {
  setInspectConfiguredProviderForTest(
    inspect: (params: {
      config: OpenClawConfig;
      agentId: string;
      env: NodeJS.ProcessEnv;
      agentDatabasePath: string;
    }) => Promise<{ provider: string; reason: string } | null>,
  ): void;
  reset(): void;
};

function getTestApi(): TestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.memoryCoreVectorIndexProviderDiagnosticTestApi")
  ] as TestApi;
}

export const vectorIndexProviderDiagnosticTesting = {
  setInspectConfiguredProviderForTest(
    inspect: Parameters<TestApi["setInspectConfiguredProviderForTest"]>[0],
  ): void {
    getTestApi().setInspectConfiguredProviderForTest(inspect);
  },
  reset(): void {
    getTestApi().reset();
  },
};
