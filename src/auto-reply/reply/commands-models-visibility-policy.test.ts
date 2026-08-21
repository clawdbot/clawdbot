// Regression test for openclaw#127379: the /models browse path must thread the
// prepared owner's plugin manifest into createModelVisibilityPolicy and pass the
// built policy to resolveLogicalVisibleModelCatalog so the callee does not rebuild
// the same policy a second time. Isolated from commands-models.test.ts to keep that
// file under the repo's test-file max-lines limit.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildModelsProviderData } from "./commands-models.js";

const modelCatalogMocks = vi.hoisted(() => ({ loadModelCatalog: vi.fn() }));

const pluginMetadataMocks = vi.hoisted(() => ({
  snapshot: undefined as
    | {
        plugins: unknown[];
        owners: {
          cliBackends: Map<string, string>;
        };
      }
    | undefined,
}));

const visibilityPolicyMocks = vi.hoisted(() => ({
  createModelVisibilityPolicy: vi.fn(),
}));

const normalizeProviderModelIdWithRuntimeMock = vi.hoisted(() => vi.fn());

// buildModelsProviderData calls createProviderAuthChecker + evaluateModelAuth on the
// browse path; the real implementation touches the auth-profile store / keychain /
// env, so it is mocked here like in commands-models.test.ts.
const modelProviderAuthMocks = vi.hoisted(() => {
  const state = {
    authenticatedProviders: new Set(["anthropic", "google", "openai"]),
    createProviderAuthChecker: vi.fn(),
  };
  state.createProviderAuthChecker.mockImplementation(() => {
    const checker = vi.fn((provider: string) => state.authenticatedProviders.has(provider));
    return Object.assign(checker, {
      evaluateModelAuth: vi.fn(async (provider: string) => ({
        availability: state.authenticatedProviders.has(provider),
        routeResolution: null,
      })),
    });
  });
  return state;
});

function setFastModelsCliBackendDeps(): void {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        pluginId: "claude-cli",
        modelProvider: "anthropic",
        config: { command: "claude" },
        bundleMcp: false,
      },
      {
        id: "google-gemini-cli",
        pluginId: "google-gemini-cli",
        modelProvider: "google",
        config: { command: "gemini" },
        bundleMcp: false,
      },
    ],
  });
}

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalog: modelCatalogMocks.loadModelCatalog,
  loadPreparedModelCatalogSnapshot: async (...args: unknown[]) => {
    const entries = await modelCatalogMocks.loadModelCatalog(...args);
    return { entries, routeVariants: entries };
  },
  loadPreparedModelCatalogOwnerSnapshot: async (...args: unknown[]) => {
    const entries = await modelCatalogMocks.loadModelCatalog(...args);
    return {
      modelCatalog: { entries, routeVariants: entries },
      metadataSnapshot: pluginMetadataMocks.snapshot,
    };
  },
}));

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: (params: unknown) =>
    normalizeProviderModelIdWithRuntimeMock(params),
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: () => pluginMetadataMocks.snapshot,
}));

vi.mock("../../agents/model-provider-auth.js", () => ({
  createProviderAuthChecker: modelProviderAuthMocks.createProviderAuthChecker,
  hasAuthForModelProvider: ({ provider }: { provider: string }) =>
    modelProviderAuthMocks.authenticatedProviders.has(provider),
  getCurrentProviderAuthState: () => null,
  clearCurrentProviderAuthState: () => undefined,
}));

vi.mock("../../agents/model-visibility-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-visibility-policy.js")>();
  return {
    ...actual,
    createModelVisibilityPolicy: (
      params: Parameters<(typeof actual)["createModelVisibilityPolicy"]>[0],
    ) => {
      visibilityPolicyMocks.createModelVisibilityPolicy(params);
      return actual.createModelVisibilityPolicy(params);
    },
  };
});

beforeAll(() => {
  setFastModelsCliBackendDeps();
  modelCatalogMocks.loadModelCatalog.mockResolvedValue([
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
  ]);
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
});

describe("buildModelsProviderData visibility policy reuse", () => {
  it("reuses the visibility policy instead of rebuilding it on the /models browse path", async () => {
    pluginMetadataMocks.snapshot = {
      plugins: [],
      owners: { cliBackends: new Map<string, string>() },
    };
    visibilityPolicyMocks.createModelVisibilityPolicy.mockClear();

    await buildModelsProviderData({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
    } as OpenClawConfig);

    expect(visibilityPolicyMocks.createModelVisibilityPolicy).toHaveBeenCalledTimes(1);
    const policyParams = visibilityPolicyMocks.createModelVisibilityPolicy.mock.calls[0]?.[0];
    expect(policyParams).toHaveProperty("manifestPlugins");
  });
});
