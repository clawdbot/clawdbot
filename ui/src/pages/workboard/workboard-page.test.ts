import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createWorkboardCapability } from "../../lib/workboard/capability.ts";
import type { WorkboardCapability } from "../../lib/workboard/capability.ts";

const { configureLiveRefresh, handleChanged, loadBoard, stopLiveRefresh, stopLifecycleRefresh } =
  vi.hoisted(() => ({
    configureLiveRefresh: vi.fn((): boolean => false),
    handleChanged: vi.fn(),
    loadBoard: vi.fn(async () => true),
    stopLiveRefresh: vi.fn(),
    stopLifecycleRefresh: vi.fn(),
  }));

vi.mock("../../lib/workboard/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workboard/index.ts")>()),
  configureWorkboardLiveRefresh: configureLiveRefresh,
  handleWorkboardChanged: handleChanged,
  loadWorkboard: loadBoard,
  stopWorkboardLifecycleRefresh: stopLifecycleRefresh,
  stopWorkboardLiveRefresh: stopLiveRefresh,
  syncWorkboardLifecycle: vi.fn(async () => undefined),
}));

await import("./workboard-page.ts");

type WorkboardPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
  syncWorkboardAgentScope: () => void;
};

function contextWithWorkboard(workboard: WorkboardCapability): ApplicationContext {
  const snapshot: ApplicationGatewaySnapshot = {
    client: null,
    connected: false,
    reconnecting: false,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const subscribe = () => () => undefined;
  return {
    basePath: "",
    gateway: {
      snapshot,
      subscribe,
      subscribeEvents: subscribe,
    } as unknown as ApplicationContext["gateway"],
    agents: {
      state: { agentsList: null, agentsLoading: false },
      subscribe,
      ensureList: vi.fn(async () => undefined),
    } as unknown as ApplicationContext["agents"],
    runtimeConfig: {
      state: {
        configSnapshot: {
          config: { plugins: { entries: { workboard: { enabled: true } } } },
        },
        configLoading: false,
      },
      subscribe,
      ensureLoaded: vi.fn(async () => undefined),
    } as unknown as ApplicationContext["runtimeConfig"],
    sessions: {
      state: { result: null, loading: false },
      subscribe,
      refresh: vi.fn(async () => undefined),
    } as unknown as ApplicationContext["sessions"],
    agentSelection: {
      state: { selectedId: "main", scopeId: "main" },
      set: () => undefined,
      setScope: () => undefined,
      subscribe,
    },
    workboard,
    navigate: vi.fn(),
    preload: vi.fn(async () => undefined),
  } as unknown as ApplicationContext;
}

afterEach(() => {
  document.body.replaceChildren();
  configureLiveRefresh.mockReset().mockReturnValue(false);
  loadBoard.mockClear();
  vi.clearAllMocks();
});

describe("WorkboardPage lifecycle", () => {
  it("routes Workboard invalidation events to the active capability", async () => {
    const workboard = createWorkboardCapability();
    const context = contextWithWorkboard(workboard);
    let eventListener: Parameters<typeof context.gateway.subscribeEvents>[0] | undefined;
    context.gateway.subscribeEvents = (listener) => {
      eventListener = listener;
      return () => undefined;
    };
    context.gateway.snapshot.connected = true;
    context.gateway.snapshot.client = { request: vi.fn() } as never;
    const page = document.createElement("openclaw-workboard-page") as WorkboardPageTestElement;
    page.context = context;
    document.body.append(page);
    await page.updateComplete;

    eventListener?.({
      type: "event",
      event: "plugin.workboard.changed",
      payload: { epoch: "epoch-a", revision: 1 },
    });

    expect(handleChanged).toHaveBeenCalledWith(workboard, {
      epoch: "epoch-a",
      revision: 1,
    });
  });

  it("forces one canonical reload when the live client is newly installed", async () => {
    const workboard = createWorkboardCapability();
    const context = contextWithWorkboard(workboard);
    context.gateway.snapshot.connected = true;
    context.gateway.snapshot.client = { request: vi.fn() } as never;
    configureLiveRefresh.mockReturnValueOnce(true);
    const page = document.createElement("openclaw-workboard-page") as WorkboardPageTestElement;
    page.context = context;
    document.body.append(page);
    await page.updateComplete;

    expect(loadBoard).toHaveBeenCalledWith(
      expect.objectContaining({ host: workboard, force: true }),
    );
  });

  it("tears down immediately when the Gateway disconnects", async () => {
    const workboard = createWorkboardCapability();
    const context = contextWithWorkboard(workboard);
    let snapshotListener: Parameters<typeof context.gateway.subscribe>[0] | undefined;
    context.gateway.subscribe = (listener) => {
      snapshotListener = listener;
      return () => undefined;
    };
    context.gateway.snapshot.connected = true;
    context.gateway.snapshot.client = { request: vi.fn() } as never;
    const page = document.createElement("openclaw-workboard-page") as WorkboardPageTestElement;
    page.context = context;
    document.body.append(page);
    await page.updateComplete;
    vi.clearAllMocks();

    snapshotListener?.({ ...context.gateway.snapshot, connected: false, client: null });

    expect(stopLiveRefresh).toHaveBeenCalledWith(workboard);
    expect(stopLifecycleRefresh).toHaveBeenCalledWith(workboard);
  });

  it("stops the previous capability runtime when the workboard source changes", async () => {
    const first = createWorkboardCapability();
    const second = createWorkboardCapability();
    const page = document.createElement("openclaw-workboard-page") as WorkboardPageTestElement;
    page.context = contextWithWorkboard(first);
    document.body.append(page);
    await page.updateComplete;
    vi.clearAllMocks();

    page.context = contextWithWorkboard(second);
    (page as unknown as { requestUpdate: () => void }).requestUpdate();
    await page.updateComplete;

    expect(stopLiveRefresh).toHaveBeenCalledWith(first);
    expect(stopLifecycleRefresh).toHaveBeenCalledWith(first);
  });

  it("closes card overlays that leave the selected agent scope", async () => {
    const workboard = createWorkboardCapability();
    const context = contextWithWorkboard(workboard);
    const page = document.createElement("openclaw-workboard-page") as WorkboardPageTestElement;
    page.context = context;
    document.body.append(page);
    await page.updateComplete;
    workboard.state.cards = [
      {
        id: "writer-card",
        title: "Writer task",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 0,
        createdAt: 1,
        updatedAt: 1,
        agentId: "writer",
      },
    ];
    workboard.state.detailCardId = "writer-card";
    workboard.state.detailCommentBody = "draft comment";
    workboard.state.draftOpen = true;
    workboard.state.editingCardId = "writer-card";
    context.agentSelection.state.scopeId = "writer";
    page.syncWorkboardAgentScope();
    context.agentSelection.state.scopeId = "main";

    page.syncWorkboardAgentScope();

    expect(workboard.state.detailCardId).toBeNull();
    expect(workboard.state.detailCommentBody).toBe("");
    expect(workboard.state.draftOpen).toBe(false);
    expect(workboard.state.editingCardId).toBeNull();
  });

  it("keeps card overlays that remain inside the selected agent scope", async () => {
    const workboard = createWorkboardCapability();
    const context = contextWithWorkboard(workboard);
    const page = document.createElement("openclaw-workboard-page") as WorkboardPageTestElement;
    page.context = context;
    document.body.append(page);
    await page.updateComplete;
    workboard.state.cards = [
      {
        id: "writer-card",
        title: "Writer task",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 0,
        createdAt: 1,
        updatedAt: 1,
        agentId: "writer",
      },
    ];
    workboard.state.detailCardId = "writer-card";
    workboard.state.detailCommentBody = "draft comment";
    workboard.state.draftOpen = true;
    workboard.state.editingCardId = "writer-card";
    context.agentSelection.state.scopeId = "writer";
    page.syncWorkboardAgentScope();
    context.agentSelection.state.scopeId = null;

    page.syncWorkboardAgentScope();

    expect(workboard.state.detailCardId).toBe("writer-card");
    expect(workboard.state.detailCommentBody).toBe("draft comment");
    expect(workboard.state.draftOpen).toBe(true);
    expect(workboard.state.editingCardId).toBe("writer-card");
  });
});
