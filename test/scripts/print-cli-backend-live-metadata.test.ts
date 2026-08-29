// Print Cli Backend Live Metadata tests cover print cli backend live metadata script behavior.
import { describe, expect, it, vi } from "vitest";
import {
  resolveCliBackendDockerPackages,
  resolveCliBackendLiveMetadata,
} from "../../scripts/print-cli-backend-live-metadata.js";

vi.mock("../../src/agents/cli-backends.js", () => ({
  resolveCliBackendConfig: () => ({ config: { command: "fixture-cli" } }),
  resolveCliBackendLiveTest: (provider: string) => ({
    defaultModelRef: `${provider}/model`,
    ...(provider.startsWith("fixture-cli") ? { dockerNpmPackage: "@fixture/cli@1.2.3" } : {}),
  }),
}));
vi.mock("../../src/plugins/setup-registry.js", () => ({
  resolvePluginSetupRegistry: () => ({
    cliBackends: [{ backend: { id: "fixture-cli", modelProvider: "fixture-provider" } }],
  }),
}));

describe("print-cli-backend-live-metadata", () => {
  it.each([
    { providers: ["api-provider"], expected: [] },
    { providers: ["fixture-provider"], expected: ["@fixture/cli@1.2.3"] },
    {
      providers: ["fixture-cli", "fixture-cli-alias", "api-provider"],
      expected: ["@fixture/cli@1.2.3"],
    },
    { providers: [], expected: ["@fixture/cli@1.2.3"] },
  ])("resolves only selected Docker CLI packages: $providers", async ({ providers, expected }) => {
    expect(await resolveCliBackendDockerPackages(providers)).toEqual(expected);
  });

  it("builds one unsupported codex-cli metadata payload", async () => {
    expect(await resolveCliBackendLiveMetadata("codex-cli")).toEqual({
      provider: "codex-cli",
      unsupported: true,
      reason:
        "codex-cli is no longer a bundled CLI backend. Use openai/* with the Codex app-server runtime instead.",
    });
  });
});
