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
  setInspectConfiguredProviderStartupForTest(
    inspect: (params: {
      config: OpenClawConfig;
      agentId: string;
      env: NodeJS.ProcessEnv;
      agentDatabasePath: string;
    }) => Promise<
      | { status: "ready" }
      | {
          status: "blocked";
          issues: Array<{
            provider: string;
            code: string;
            message: string;
            remediation?: readonly string[];
          }>;
        }
      | { status: "indeterminate"; reason: string }
    >,
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
  setInspectConfiguredProviderStartupForTest(
    inspect: Parameters<TestApi["setInspectConfiguredProviderStartupForTest"]>[0],
  ): void {
    getTestApi().setInspectConfiguredProviderStartupForTest(inspect);
  },
  reset(): void {
    getTestApi().reset();
  },
};
