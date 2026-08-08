/** Regression coverage for canonical provider account selection and live Gateway refresh. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAuthProfileOrder } from "../../agents/auth-profiles/order.js";
import {
  clearRuntimeAuthProfileStoreSnapshot,
  getRuntimeAuthProfileStoreSnapshot,
  setRuntimeAuthProfileStoreSnapshot,
} from "../../agents/auth-profiles/runtime-snapshots.js";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { resetProviderAuthAliasMapCacheForTest } from "../../agents/provider-auth-aliases.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutputRuntimeEnv } from "../../runtime.js";
import {
  modelsAuthOrderClearCommand,
  modelsAuthOrderGetCommand,
  modelsAuthOrderSetCommand,
} from "./auth-order.js";

const agentDir = "/tmp/openclaw-auth-order-owner-main";
const primaryProfileId = "fixture-provider:primary";
const backupProfileId = "fixture-provider:backup";

const mocks = vi.hoisted(() => {
  const snapshot = {
    plugins: [
      {
        id: "fixture-provider",
        origin: "bundled",
        providerAuthAliases: {
          "fixture-provider-plan": "fixture-provider",
          "fixture-provider-enterprise": "fixture-provider",
        },
      },
    ],
    diagnostics: [],
  };
  return {
    callGateway: vi.fn(async (_params: unknown) => ({})),
    ensureAuthProfileStore: vi.fn(),
    externalCliDiscoveryForProviderAuth: vi.fn(() => ({ kind: "none" as const })),
    getCurrentPluginMetadataSnapshot: vi.fn(() => snapshot),
    loadModelsConfig: vi.fn(),
    loadPluginMetadataSnapshot: vi.fn(() => snapshot),
    persistedStore: { version: 1, profiles: {} } as AuthProfileStore,
    setAuthProfileOrder: vi.fn(),
  };
});

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  externalCliDiscoveryForProviderAuth: mocks.externalCliDiscoveryForProviderAuth,
  resolveAuthStatePathForDisplay: (directory: string) => `${directory}/openclaw-agent.sqlite`,
  setAuthProfileOrder: mocks.setAuthProfileOrder,
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: mocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", () => ({
  resolveModelsTargetAgent: (_cfg: OpenClawConfig, requestedAgentId?: string) => ({
    agentId: requestedAgentId ?? "main",
    agentDir,
  }),
}));

function createProfileStore(params?: {
  credentialProvider?: string;
  order?: string[];
}): AuthProfileStore {
  const credentialProvider = params?.credentialProvider ?? "fixture-provider";
  return {
    version: 1,
    profiles: {
      [primaryProfileId]: {
        type: "api_key",
        provider: credentialProvider,
        key: "fixture-primary-key",
      },
      [backupProfileId]: {
        type: "api_key",
        provider: credentialProvider,
        key: "fixture-backup-key",
      },
    },
    ...(params?.order ? { order: { "fixture-provider": params.order } } : {}),
  };
}

function createRuntime(): OutputRuntimeEnv & { logs: string[]; jsonPayloads: unknown[] } {
  const logs: string[] = [];
  const jsonPayloads: unknown[] = [];
  return {
    logs,
    jsonPayloads,
    log: (...values: unknown[]) => logs.push(values.map(String).join(" ")),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: (value: unknown) => jsonPayloads.push(value),
  };
}

function expectGatewayRefresh() {
  expect(mocks.callGateway).toHaveBeenCalledWith({
    method: "models.authStatus",
    params: { refresh: true },
    timeoutMs: 3000,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProviderAuthAliasMapCacheForTest();
  mocks.persistedStore = createProfileStore({ order: [primaryProfileId] });
  mocks.loadModelsConfig.mockResolvedValue({} as OpenClawConfig);
  mocks.ensureAuthProfileStore.mockImplementation(() => mocks.persistedStore);
  mocks.callGateway.mockResolvedValue({});
  mocks.setAuthProfileOrder.mockImplementation(
    async (params: { provider: string; order?: string[] | null }) => {
      const store = structuredClone(mocks.persistedStore);
      store.order = { ...store.order };
      if (params.order?.length) {
        store.order[params.provider] = params.order;
      } else {
        delete store.order[params.provider];
      }
      mocks.persistedStore = store;
      return store;
    },
  );
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshot(agentDir);
});

describe("models auth order", () => {
  it("reads the canonical provider account order through its manifest auth alias", async () => {
    const runtime = createRuntime();

    await modelsAuthOrderGetCommand({ provider: "fixture-provider-plan", json: true }, runtime);

    expect(runtime.jsonPayloads).toEqual([
      expect.objectContaining({
        provider: "fixture-provider",
        order: [primaryProfileId],
      }),
    ]);
    expect(mocks.externalCliDiscoveryForProviderAuth).toHaveBeenCalledWith({
      cfg: {},
      provider: "fixture-provider",
    });
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("reports an existing account order stored under a historical provider alias", async () => {
    mocks.persistedStore.order = {
      "fixture-provider-plan": [backupProfileId],
      "different-provider": ["different-provider:default"],
    };
    const runtime = createRuntime();

    await modelsAuthOrderGetCommand({ provider: "fixture-provider", json: true }, runtime);

    expect(runtime.jsonPayloads).toEqual([
      expect.objectContaining({
        provider: "fixture-provider",
        order: [backupProfileId],
      }),
    ]);
  });

  it("prefers the canonical account order when historical alias duplicates remain", async () => {
    mocks.persistedStore.order = {
      "fixture-provider-plan": [backupProfileId],
      "fixture-provider-enterprise": [backupProfileId],
      "fixture-provider": [primaryProfileId],
    };
    const runtime = createRuntime();

    await modelsAuthOrderGetCommand({ provider: "fixture-provider-plan", json: true }, runtime);

    expect(runtime.jsonPayloads).toEqual([expect.objectContaining({ order: [primaryProfileId] })]);
  });

  it.each([
    {
      label: "canonical credentials selected through an alias",
      requestedProvider: "fixture-provider-plan",
      credentialProvider: "fixture-provider",
    },
    {
      label: "alias credentials selected through their canonical provider",
      requestedProvider: "fixture-provider",
      credentialProvider: "fixture-provider-plan",
    },
  ])("sets $label and refreshes the live Gateway", async (params) => {
    mocks.persistedStore = createProfileStore({
      credentialProvider: params.credentialProvider,
      order: [primaryProfileId],
    });

    await modelsAuthOrderSetCommand(
      { provider: params.requestedProvider, order: [backupProfileId] },
      createRuntime(),
    );

    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir,
      config: {},
      provider: "fixture-provider",
      order: [backupProfileId],
    });
    expectGatewayRefresh();
  });

  it("clears the canonical account order through its alias and refreshes the Gateway", async () => {
    await modelsAuthOrderClearCommand({ provider: "fixture-provider-plan" }, createRuntime());

    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir,
      config: {},
      provider: "fixture-provider",
      order: null,
    });
    expectGatewayRefresh();
  });

  it.each(["set", "clear"] as const)(
    "never refreshes the Gateway after a failed %s store write",
    async (operation) => {
      mocks.setAuthProfileOrder.mockResolvedValueOnce(null);
      const runtime = createRuntime();
      const action =
        operation === "set"
          ? modelsAuthOrderSetCommand(
              { provider: "fixture-provider", order: [backupProfileId] },
              runtime,
            )
          : modelsAuthOrderClearCommand({ provider: "fixture-provider" }, runtime);

      await expect(action).rejects.toThrow("auth state lock may be busy");
      expect(mocks.callGateway).not.toHaveBeenCalled();
    },
  );

  it("never refreshes the Gateway when a profile belongs to another provider", async () => {
    mocks.persistedStore = createProfileStore({ credentialProvider: "different-provider" });

    await expect(
      modelsAuthOrderSetCommand(
        { provider: "fixture-provider", order: [primaryProfileId] },
        createRuntime(),
      ),
    ).rejects.toThrow(`Auth profile "${primaryProfileId}" is for different-provider`);

    expect(mocks.setAuthProfileOrder).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("applies account switching to the actual running-Gateway auth snapshot", async () => {
    setRuntimeAuthProfileStoreSnapshot(mocks.persistedStore, agentDir);
    const oldGatewayStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
    expect(oldGatewayStore).toBeDefined();
    expect(
      resolveAuthProfileOrder({
        cfg: {},
        store: oldGatewayStore!,
        provider: "fixture-provider-plan",
      }),
    ).toEqual([primaryProfileId]);

    mocks.callGateway.mockImplementationOnce(async () => {
      setRuntimeAuthProfileStoreSnapshot(mocks.persistedStore, agentDir);
      return {};
    });

    await modelsAuthOrderSetCommand(
      { provider: "fixture-provider", order: [backupProfileId] },
      createRuntime(),
    );

    const refreshedGatewayStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
    expect(refreshedGatewayStore).toBeDefined();
    expect(
      resolveAuthProfileOrder({
        cfg: {},
        store: refreshedGatewayStore!,
        provider: "fixture-provider-plan",
      }),
    ).toEqual([backupProfileId]);
    expectGatewayRefresh();
  });

  it("keeps a successful persisted account change when the Gateway is unavailable", async () => {
    mocks.callGateway.mockRejectedValueOnce(new Error("gateway unavailable"));
    const runtime = createRuntime();

    await modelsAuthOrderSetCommand(
      { provider: "fixture-provider", order: [backupProfileId] },
      runtime,
    );

    expect(mocks.persistedStore.order?.["fixture-provider"]).toEqual([backupProfileId]);
    expect(runtime.logs).toContain(`Auth profile order override: ${backupProfileId}`);
    expectGatewayRefresh();
  });
});
