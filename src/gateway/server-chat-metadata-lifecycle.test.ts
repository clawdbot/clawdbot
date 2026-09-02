import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const mocks = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  fail: vi.fn(),
  invalidate: vi.fn(),
  read: vi.fn(),
  readStartup: vi.fn(),
  refreshPreparedModels: vi.fn(),
  refresh: vi.fn(),
  registerAuthListener: vi.fn(),
  registerModelListener: vi.fn(),
  registerSkillsListener: vi.fn(),
  unregisterAuthListener: vi.fn(),
  unregisterModelListener: vi.fn(),
  unregisterSkillsListener: vi.fn(),
}));

vi.mock("./server-methods/chat-metadata-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-methods/chat-metadata-runtime.js")>()),
  createGatewayChatMetadataRuntime: mocks.createRuntime,
}));
vi.mock("../agents/auth-profiles/runtime-snapshots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles/runtime-snapshots.js")>()),
  registerRuntimeAuthProfileStoreMutationListener: mocks.registerAuthListener,
}));
vi.mock("../agents/prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.js")>()),
  refreshPreparedModelRuntimeSnapshots: mocks.refreshPreparedModels,
  registerPreparedModelRuntimePublicationListener: mocks.registerModelListener,
}));
vi.mock("../skills/runtime/refresh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/runtime/refresh.js")>()),
  registerSkillsChangeListener: mocks.registerSkillsListener,
}));

const { createGatewayChatMetadataLifecycle } = await import("./server-chat-metadata-lifecycle.js");
const { ChatMetadataSnapshotUnavailableError } =
  await import("./server-methods/chat-metadata-runtime.js");

const config = {} as OpenClawConfig;
const context = {} as GatewayRequestContext;

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.createRuntime.mockReturnValue({
    fail: mocks.fail,
    invalidate: mocks.invalidate,
    read: mocks.read,
    readStartup: mocks.readStartup,
    refresh: mocks.refresh,
  });
  mocks.refresh.mockResolvedValue(undefined);
  mocks.registerAuthListener.mockReturnValue(mocks.unregisterAuthListener);
  mocks.registerModelListener.mockReturnValue(mocks.unregisterModelListener);
  mocks.registerSkillsListener.mockReturnValue(mocks.unregisterSkillsListener);
});

function createLifecycle(minimalTestGateway: boolean, warn = vi.fn()) {
  return {
    lifecycle: createGatewayChatMetadataLifecycle({
      getConfig: () => config,
      minimalTestGateway,
      log: { warn } as never,
    }),
    warn,
  };
}

describe("gateway chat metadata lifecycle", () => {
  it("broadcasts settled metadata through the production lifecycle without a failure feedback loop", async () => {
    const actual = await vi.importActual<
      typeof import("./server-methods/chat-metadata-runtime.js")
    >("./server-methods/chat-metadata-runtime.js");
    const owner: PreparedModelRuntimeSnapshot = {
      catalogOwner: { agentId: "main", workspaceDir: "/tmp/metadata-lifecycle/workspace" },
      agentId: "main",
      agentDir: "/tmp/metadata-lifecycle/agent",
      workspaceDir: "/tmp/metadata-lifecycle/workspace",
      activeProjectKeys: [],
      config,
      authModes: {},
      oauthRefreshProviderIds: [],
      metadataSnapshot: createPluginMetadataSnapshot({
        config,
        manifestRegistry: { plugins: [], diagnostics: [] },
      }),
      allowGatewaySubagentBinding: false,
      modelCatalog: {
        entries: [{ id: "model", name: "Model", provider: "test" }],
        routeVariants: [],
      },
      configuredRuntimeModels: [],
      inlineProviderModels: [],
      createStores: () => {
        throw new Error("metadata must not create live model stores");
      },
    };
    const getPreparedOwner = vi.fn<() => PreparedModelRuntimeSnapshot | undefined>();
    let available = false;
    let revision = 0;
    const buildProjection = vi.fn(async () => {
      const projection = {
        modelCatalog: owner.modelCatalog.entries,
        models: [{ ...owner.modelCatalog.entries[0], available }],
      };
      return { read: () => projection, isCurrent: () => true };
    });
    mocks.createRuntime.mockImplementation((params) =>
      actual.createGatewayChatMetadataRuntime({
        ...params,
        deps: {
          getPreparedOwner,
          getPreparedAuthStore: () => ({ version: 1, profiles: {} }),
          getAuthStoreRevision: () => revision,
          getSkillsVersion: () => 0,
          getPluginRegistryVersion: () => 0,
          buildCommands: async () => ({ commands: [] }),
          buildProjection,
        },
      }),
    );
    const lifecycle = await createLifecycle(false).lifecycle;
    const outcomes: unknown[] = [];
    const reads: Promise<void>[] = [];
    const broadcast = vi.fn(() => {
      // Read immediately from the outbound boundary: the replacement must already be settled.
      reads.push(
        lifecycle.read({ agentId: "main" }).then(
          (metadata) => {
            outcomes.push(metadata.models);
          },
          (error: unknown) => {
            outcomes.push(error instanceof Error ? error.message : error);
          },
        ),
      );
    });
    await lifecycle.attachContext({ broadcast } as unknown as GatewayRequestContext, []);
    await Promise.all(reads);
    expect(outcomes).toEqual([expect.stringContaining("owner is unavailable")]);
    expect(broadcast).toHaveBeenCalledOnce();
    getPreparedOwner.mockReturnValue(owner);
    const modelListener = mocks.registerModelListener.mock.calls[0]![0];
    const authListener = mocks.registerAuthListener.mock.calls[0]![0];
    modelListener({ phase: "published" });
    await vi.waitFor(() => expect(outcomes).toHaveLength(2));
    expect(outcomes[1]).toEqual([expect.objectContaining({ available: false })]);

    modelListener({ phase: "invalidated" });
    available = true;
    revision += 1;
    authListener();
    expect(broadcast).toHaveBeenCalledTimes(2);
    modelListener({ phase: "published" });
    await vi.waitFor(() => expect(outcomes).toHaveLength(3));
    expect(outcomes[2]).toEqual([expect.objectContaining({ available: true })]);

    available = false;
    revision += 1;
    authListener();
    await vi.waitFor(() => expect(outcomes).toHaveLength(4));
    expect(outcomes[3]).toEqual([expect.objectContaining({ available: false })]);

    const gate = createDeferred();
    buildProjection.mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error("superseded projection");
    });
    revision += 1;
    authListener();
    await vi.waitFor(() => expect(buildProjection).toHaveBeenCalledTimes(4));
    modelListener({ phase: "invalidated" });
    available = true;
    revision += 1;
    modelListener({ phase: "published" });
    gate.resolve();
    await vi.waitFor(() => expect(outcomes).toHaveLength(5));
    expect(outcomes[4]).toEqual([expect.objectContaining({ available: true })]);

    modelListener({ phase: "invalidated" });
    modelListener({ phase: "failed", error: new Error("owner publication failed") });
    await Promise.all(reads);
    await expect(lifecycle.read({ agentId: "main" })).rejects.toThrow("owner publication failed");
    expect(outcomes[5]).toBe("owner publication failed");
    expect(broadcast.mock.calls).toEqual(
      Array.from({ length: 6 }, () => ["chat.metadata.changed", {}, { dropIfSlow: true }]),
    );
  });

  it("keeps minimal Gateway attachment lazy and sidecar-free", async () => {
    const { lifecycle: pendingLifecycle } = createLifecycle(true);
    const lifecycle = await pendingLifecycle;
    const sidecars: Array<{ stop: () => Promise<void> }> = [];

    await lifecycle.attachContext(context, sidecars);

    expect(mocks.createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeRefresh: expect.any(Function),
        refreshOnRead: true,
      }),
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.registerAuthListener).not.toHaveBeenCalled();
    expect(mocks.registerModelListener).not.toHaveBeenCalled();
    expect(mocks.registerSkillsListener).not.toHaveBeenCalled();
    expect(sidecars).toEqual([]);
  });

  it("treats an unavailable catch-up snapshot as expected before owner publication", async () => {
    mocks.refresh.mockRejectedValueOnce(new ChatMetadataSnapshotUnavailableError());
    const { lifecycle: pendingLifecycle, warn } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;
    const sidecars: Array<{ stop: () => Promise<void> }> = [];

    await lifecycle.attachContext(context, sidecars);

    expect(mocks.registerAuthListener).toHaveBeenCalledOnce();
    expect(mocks.registerModelListener).toHaveBeenCalledOnce();
    expect(mocks.registerSkillsListener).toHaveBeenCalledOnce();
    expect(sidecars).toHaveLength(1);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();

    const listener = mocks.registerModelListener.mock.calls[0]?.[0];
    expect(listener).toEqual(expect.any(Function));
    listener({ phase: "published" });

    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
  });

  it("logs unexpected catch-up failures without rejecting startup", async () => {
    mocks.refresh.mockRejectedValueOnce(new Error("metadata unavailable"));
    const { lifecycle: pendingLifecycle, warn } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;

    await expect(lifecycle.attachContext(context, [])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "chat metadata catch-up refresh failed: Error: metadata unavailable",
    );
  });

  it("retries subordinate changes after a published owner's catch-up build fails", async () => {
    mocks.refresh.mockRejectedValueOnce(new Error("projection failed"));
    const { lifecycle: pendingLifecycle } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;

    await lifecycle.attachContext(context, []);
    const authListener = mocks.registerAuthListener.mock.calls[0]?.[0];

    authListener();

    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
  });

  it("defers subordinate changes until an invalidated model owner publishes", async () => {
    mocks.refresh.mockRejectedValueOnce(new ChatMetadataSnapshotUnavailableError());
    const { lifecycle: pendingLifecycle, warn } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;

    await lifecycle.attachContext(context, []);
    expect(mocks.refresh).toHaveBeenCalledOnce();

    const modelListener = mocks.registerModelListener.mock.calls[0]?.[0];
    const authListener = mocks.registerAuthListener.mock.calls[0]?.[0];
    const skillsListener = mocks.registerSkillsListener.mock.calls[0]?.[0];
    expect(modelListener).toEqual(expect.any(Function));
    expect(authListener).toEqual(expect.any(Function));
    expect(skillsListener).toEqual(expect.any(Function));

    modelListener({ phase: "invalidated" });
    modelListener({ phase: "catalog-published" });
    authListener();
    skillsListener();

    expect(mocks.invalidate).toHaveBeenCalledTimes(4);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();

    modelListener({ phase: "published" });

    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
    expect(warn).not.toHaveBeenCalled();
  });

  it("refreshes subordinate changes immediately while the model owner is published", async () => {
    const { lifecycle: pendingLifecycle } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;

    await lifecycle.attachContext(context, []);
    const authListener = mocks.registerAuthListener.mock.calls[0]?.[0];
    const skillsListener = mocks.registerSkillsListener.mock.calls[0]?.[0];

    authListener();
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
    skillsListener();
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(3));
  });

  it("refreshes after the prepared owner publishes a completed full catalog", async () => {
    const { lifecycle: pendingLifecycle } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;

    await lifecycle.attachContext(context, []);
    const modelListener = mocks.registerModelListener.mock.calls[0]?.[0];
    modelListener({ phase: "published" });
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
    mocks.invalidate.mockClear();

    modelListener({ phase: "catalog-published" });

    expect(mocks.invalidate).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(3));
  });

  it("keeps an owner available when a subordinate catalog publishes during attachment", async () => {
    const pendingRefresh = createDeferred();
    mocks.refresh.mockReturnValueOnce(pendingRefresh.promise);
    const { lifecycle: pendingLifecycle } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;

    const attachment = lifecycle.attachContext(context, []);
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    const modelListener = mocks.registerModelListener.mock.calls[0]?.[0];
    modelListener({ phase: "catalog-published" });
    pendingRefresh.resolve();
    await attachment;

    const authListener = mocks.registerAuthListener.mock.calls[0]?.[0];
    authListener();

    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
  });

  it("propagates a failed model publication without starting a refresh", async () => {
    const { lifecycle: pendingLifecycle } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;

    await lifecycle.attachContext(context, []);
    const modelListener = mocks.registerModelListener.mock.calls[0]?.[0];
    const publicationError = new Error("replacement failed");

    modelListener({ phase: "invalidated" });
    modelListener({ phase: "failed", error: publicationError });

    expect(mocks.fail).toHaveBeenCalledWith(publicationError);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});
