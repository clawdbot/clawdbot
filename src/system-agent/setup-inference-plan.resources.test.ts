import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareAuthChoiceLoadedPluginProvider } from "../plugins/provider-auth-choice.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
} from "../plugins/registry-resources.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { buildTestPlan } from "./setup-inference-plan.js";

const acquisition = vi.hoisted(() =>
  vi.fn<
    typeof import("../plugins/provider-auth-choice.runtime.js").acquireProviderAuthChoiceProviders
  >(),
);
const choice = {
  pluginId: "fixture",
  providerId: "fixture",
  methodId: "api-key",
  choiceId: "fixture-api-key",
  choiceLabel: "Fixture",
};

vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  acquireProviderAuthChoiceProviders: acquisition,
  resolvePluginSetupProvider: () => undefined,
  resolveProviderPluginChoice: ({ providers }: { providers: ProviderPlugin[] }) => {
    const provider = providers[0];
    const method = provider?.auth[0];
    return provider && method ? { provider, method } : null;
  },
  runProviderModelSelectedHook: vi.fn(),
}));
vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice: () => choice,
}));
vi.mock("../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntry: () => ({
    pluginId: "fixture",
    label: "Fixture",
    onboardingScopes: ["text-inference"],
  }),
}));
vi.mock("../plugins/enable.js", () => ({
  enablePluginInConfig: (config: OpenClawConfig) => ({ config, enabled: true }),
  enablePluginWithCapabilityConsent: async (config: OpenClawConfig) => ({ config, enabled: true }),
}));
vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (_options: unknown, run: () => Promise<unknown>) => run(),
}));
vi.mock("../agents/model-runtime-aliases.js", () => ({
  resolveCliRuntimeExecutionProvider: ({ cfg }: { cfg: OpenClawConfig }) =>
    cfg.agents?.defaults?.models?.["fixture/test-model"]?.agentRuntime?.id === "fixture-cli"
      ? "fixture-cli"
      : undefined,
}));

const owners: Array<() => void> = [];
afterEach(async () => {
  for (const release of owners.splice(0)) {
    release();
  }
  await drainPluginRegistryResourceDisposals();
  acquisition.mockReset();
});

function prepareNativeProvider(runtimeId = "openclaw") {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE models (alias TEXT, canonical TEXT)");
  database.prepare("INSERT INTO models VALUES (?, ?)").run("starter-alias", "test-model");
  const normalizeModelId = vi.fn(({ modelId }: { modelId: string }) => {
    const row = database.prepare("SELECT canonical FROM models WHERE alias = ?").get(modelId);
    return typeof row?.canonical === "string" ? row.canonical : undefined;
  });
  const registry = createEmptyPluginRegistry();
  const handle = createPluginRegistryResourceOwner(registry, "scoped");
  owners.push(handle.release);
  const dispose = vi.fn(() => database.close());
  registerPluginRegistryResourceDisposer(registry, "fixture", { id: "native-models", dispose });
  const provider: ProviderPlugin = {
    id: "fixture",
    label: "Fixture",
    normalizeModelId,
    auth: [
      {
        id: "api-key",
        label: "Fixture key",
        kind: "api_key",
        run: async () => ({
          profiles: [],
          defaultModel: "fixture/starter-alias",
          configPatch: {
            agents: {
              defaults: {
                models: {
                  "fixture/starter-alias": { agentRuntime: { id: runtimeId } },
                },
              },
            },
          },
        }),
      },
    ],
  };
  acquisition.mockReturnValue({ providers: [provider], registry, release: handle.release });
  return { database, normalizeModelId, dispose };
}

const config: OpenClawConfig = { agents: { entries: { main: {} } } };
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

describe("prepared provider model resources", () => {
  it.each(["openclaw", "fixture-cli"])(
    "normalizes under the live owner and preserves raw-alias metadata for %s",
    async (runtimeId) => {
      const native = prepareNativeProvider(runtimeId);
      const plan = await buildTestPlan({
        kind: "provider-auth",
        authChoice: "fixture-api-key",
        cfg: config,
        sourceCfg: config,
        workspaceDir: "/tmp/fixture-probe",
        pluginWorkspaceDir: "/tmp/fixture-workspace",
        agentDir: "/tmp/fixture-probe/agent",
        runtime,
        prompter: createWizardPrompter(),
        deps: { resolveManifestProviderAuthChoice: () => undefined },
      });
      expect(plan).toMatchObject({
        modelRef: "fixture/test-model",
        selectedAgentRuntimeId: runtimeId,
        runner: runtimeId === "fixture-cli" ? "cli" : "embedded",
        config: {
          agents: {
            defaults: {
              models: {
                "fixture/test-model": { agentRuntime: { id: runtimeId } },
              },
            },
          },
        },
      });
      expect(native.normalizeModelId).toHaveBeenCalledExactlyOnceWith({
        provider: "fixture",
        modelId: "starter-alias",
      });
      await drainPluginRegistryResourceDisposals();
      expect(native.dispose).toHaveBeenCalledOnce();
      expect(native.database.isOpen).toBe(false);
    },
  );

  it("does not invoke model normalization for ordinary auth preparation", async () => {
    const native = prepareNativeProvider();
    const prepared = await prepareAuthChoiceLoadedPluginProvider({
      authChoice: "fixture-api-key",
      config,
      runtime,
      prompter: createWizardPrompter(),
      agentId: "main",
      agentDir: "/tmp/fixture-probe/agent",
      workspaceDir: "/tmp/fixture-workspace",
      setDefaultModel: false,
    });
    expect(prepared?.agentModelOverride).toBe("fixture/starter-alias");
    expect(native.normalizeModelId).not.toHaveBeenCalled();
    await drainPluginRegistryResourceDisposals();
    expect(native.dispose).toHaveBeenCalledOnce();
  });
});
