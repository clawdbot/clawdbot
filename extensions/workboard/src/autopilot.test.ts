import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { createWorkboardAutopilotService } from "./autopilot.js";
import type {
  PersistedWorkboardBoard,
  PersistedWorkboardCard,
  WorkboardKeyedStore,
} from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore<T>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].map(([key, value]) => ({ key, value }));
    },
  };
}

function createHarness(options: { sandboxed?: boolean; failureBackoffMs?: number } = {}) {
  const store = new WorkboardStore(createMemoryStore<PersistedWorkboardCard>(), {
    boards: createMemoryStore<PersistedWorkboardBoard>(),
  });
  const run = vi.fn().mockResolvedValue({ runId: "autopilot-run" });
  const api = {
    runtime: {
      config: { current: () => ({ agents: { defaults: { workspace: "/tmp" } } }) },
      sandbox: {
        prepareWorkspaceAuthority: vi.fn().mockResolvedValue({
          sandboxed: options.sandboxed ?? true,
          workspaceAccess: "rw",
        }),
      },
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        hasSelfContainedCheckoutMetadata: vi.fn().mockResolvedValue(true),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
    },
  } as unknown as OpenClawPluginApi;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = createWorkboardAutopilotService({
    api,
    store,
    debounceMs: 1,
    reconcileMs: 60_000,
    failureBackoffMs: options.failureBackoffMs,
  });
  const context = {
    config: {},
    stateDir: "/tmp/workboard-autopilot-test",
    logger,
  } satisfies Parameters<typeof service.start>[0];
  return { store, run, logger, service, context, api };
}

afterEach(() => vi.useRealTimers());

describe("createWorkboardAutopilotService", () => {
  it("starts one explicitly assigned ready card on a guarded board", async () => {
    vi.useFakeTimers();
    const { store, run, logger, service, context } = createHarness();
    await store.upsertBoard({
      id: "ops",
      orchestration: { autopilotMode: "guarded" },
      defaultWorkspace: { kind: "dir", path: "/tmp" },
    });
    const card = await store.create({
      title: "Guarded work",
      boardId: "ops",
      status: "ready",
      agentId: "writer",
      workspace: { kind: "dir", path: "/tmp" },
      workspaceAccess: { unrestricted: true },
    });

    await service.start(context);
    await service.reconcile();

    expect(logger.warn.mock.calls).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      execution: { mode: "autonomous", status: "running" },
    });
    await service.stop?.(context);
  });

  it("starts an unrestricted card when the assigned agent is not sandboxed", async () => {
    vi.useFakeTimers();
    const { store, run, logger, service, context, api } = createHarness({ sandboxed: false });
    await store.upsertBoard({
      id: "ops",
      orchestration: { autopilotMode: "guarded" },
      defaultWorkspace: { kind: "dir", path: "/tmp" },
    });
    await store.create({
      title: "Trusted work",
      boardId: "ops",
      status: "ready",
      agentId: "writer",
      workspace: { kind: "dir", path: "/tmp" },
      workspaceAccess: { unrestricted: true },
    });

    await service.start(context);
    await service.reconcile();

    expect(logger.warn).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(api.runtime.sandbox.prepareWorkspaceAuthority).not.toHaveBeenCalled();
    await service.stop?.(context);
  });

  it("uses the assigned agent workspace when the board and card do not override it", async () => {
    vi.useFakeTimers();
    const { store, run, logger, service, context } = createHarness({ sandboxed: false });
    await store.upsertBoard({
      id: "ops",
      orchestration: { autopilotMode: "guarded" },
    });
    await store.create({
      title: "Configured workspace",
      boardId: "ops",
      status: "ready",
      agentId: "writer",
    });

    await service.start(context);
    await service.reconcile();

    expect(logger.warn).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    await service.stop?.(context);
  });

  it("backs off a repeated restricted-card launch failure", async () => {
    vi.useFakeTimers();
    const { store, run, logger, service, context, api } = createHarness({
      sandboxed: false,
      failureBackoffMs: 1_000,
    });
    await store.upsertBoard({
      id: "ops",
      orchestration: { autopilotMode: "guarded" },
      defaultWorkspace: { kind: "dir", path: "/tmp" },
    });
    const card = await store.create({
      title: "Restricted work",
      boardId: "ops",
      status: "ready",
      agentId: "writer",
      workspace: { kind: "dir", path: "/tmp" },
      workspaceAccess: { unrestricted: false, roots: ["/tmp"], writable: true },
    });

    await service.start(context);
    await service.reconcile();
    await service.reconcile();

    expect(run).not.toHaveBeenCalled();
    expect(api.runtime.sandbox.prepareWorkspaceAuthority).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "ready",
      metadata: {
        workerLogs: [
          expect.objectContaining({
            level: "error",
            message: expect.stringContaining("target agent is not sandboxed"),
          }),
        ],
      },
    });

    vi.setSystemTime(Date.now() + 1_001);
    await service.reconcile();
    expect(api.runtime.sandbox.prepareWorkspaceAuthority).toHaveBeenCalledTimes(2);
    await service.stop?.(context);
  });

  it("keeps off and unassigned work idle", async () => {
    vi.useFakeTimers();
    const { store, run, service, context } = createHarness();
    await store.upsertBoard({ id: "manual", orchestration: { autopilotMode: "off" } });
    await store.upsertBoard({
      id: "guarded",
      orchestration: { autopilotMode: "guarded" },
      defaultWorkspace: { kind: "dir", path: "/tmp" },
    });
    await store.create({ title: "Manual", boardId: "manual", status: "ready" });
    await store.create({ title: "Needs assignee", boardId: "guarded", status: "ready" });

    await service.start(context);
    await vi.advanceTimersByTimeAsync(1);

    expect(run).not.toHaveBeenCalled();
    await service.stop?.(context);
  });

  it("starts the next card only after the active autonomous run leaves running", async () => {
    vi.useFakeTimers();
    const { store, run, service, context } = createHarness();
    await store.upsertBoard({
      id: "ops",
      orchestration: { autopilotMode: "guarded" },
      defaultWorkspace: { kind: "dir", path: "/tmp" },
    });
    const first = await store.create({
      title: "First",
      boardId: "ops",
      status: "ready",
      agentId: "writer",
      workspace: { kind: "dir", path: "/tmp" },
      workspaceAccess: { unrestricted: true },
    });
    await store.create({
      title: "Second",
      boardId: "ops",
      status: "ready",
      agentId: "reviewer",
      workspace: { kind: "dir", path: "/tmp" },
      workspaceAccess: { unrestricted: true },
    });

    await service.start(context);
    await service.reconcile();
    expect(run).toHaveBeenCalledTimes(1);

    await service.reconcile();
    expect(run).toHaveBeenCalledTimes(1);

    await store.update(first.id, { status: "review" });
    await service.reconcile();
    expect(run).toHaveBeenCalledTimes(2);
    await service.stop?.(context);
  });

  it("runs board maintenance before selecting newly unblocked work", async () => {
    vi.useFakeTimers();
    const { store, run, service, context } = createHarness();
    await store.upsertBoard({
      id: "ops",
      orchestration: { autopilotMode: "guarded" },
      defaultWorkspace: { kind: "dir", path: "/tmp" },
    });
    const parent = await store.create({ title: "Accepted plan", boardId: "ops", status: "done" });
    const child = await store.create({
      title: "Promoted child",
      boardId: "ops",
      status: "todo",
      agentId: "writer",
      parents: [parent.id],
      workspace: { kind: "dir", path: "/tmp" },
      workspaceAccess: { unrestricted: true },
    });

    await service.start(context);
    await service.reconcile();

    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(child.id)).resolves.toMatchObject({ status: "running" });
    await service.stop?.(context);
  });

  it("does not launch after guarded mode is switched off during workspace validation", async () => {
    vi.useFakeTimers();
    const { store, run, service, context, api } = createHarness();
    await store.upsertBoard({
      id: "ops",
      orchestration: { autopilotMode: "guarded" },
      defaultWorkspace: { kind: "dir", path: "/tmp" },
    });
    const card = await store.create({
      title: "Turned off while preparing",
      boardId: "ops",
      status: "ready",
      agentId: "writer",
      workspace: { kind: "dir", path: "/tmp" },
      workspaceAccess: { unrestricted: false, roots: ["/tmp"], writable: true },
    });
    type WorkspaceAuthority = Awaited<
      ReturnType<OpenClawPluginApi["runtime"]["sandbox"]["prepareWorkspaceAuthority"]>
    >;
    let releaseWorkspaceValidation: (() => void) | undefined;
    api.runtime.sandbox.prepareWorkspaceAuthority = vi.fn(
      () =>
        new Promise<WorkspaceAuthority>((resolve) => {
          releaseWorkspaceValidation = () =>
            resolve({
              sandboxed: true,
              workspaceAccess: "rw",
            });
        }),
    );

    await service.start(context);
    const reconciliation = service.reconcile();
    await vi.waitFor(() => {
      expect(api.runtime.sandbox.prepareWorkspaceAuthority).toHaveBeenCalledOnce();
    });
    await store.upsertBoard({ id: "ops", orchestration: { autopilotMode: "off" } });
    releaseWorkspaceValidation?.();
    await reconciliation;

    expect(run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
    await service.stop?.(context);
  });
});
