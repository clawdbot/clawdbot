import { beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../agents/auth-profiles/runtime-snapshots.js", () => ({
  registerRuntimeAuthProfileStoreMutationListener: mocks.registerAuthListener,
}));
vi.mock("../agents/prepared-model-runtime.js", () => ({
  refreshPreparedModelRuntimeSnapshots: mocks.refreshPreparedModels,
  registerPreparedModelRuntimePublicationListener: mocks.registerModelListener,
}));
vi.mock("../skills/runtime/refresh.js", () => ({
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
});
