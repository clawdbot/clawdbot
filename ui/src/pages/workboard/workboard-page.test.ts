import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createWorkboardCapability } from "../../lib/workboard/capability.ts";
import type { WorkboardCapability } from "../../lib/workboard/capability.ts";
import * as workboardLib from "../../lib/workboard/index.ts";
import type { WorkboardRouteData } from "./route.ts";

const configureLiveRefresh = vi.fn((): boolean => false);
const handleChanged = vi.fn();
const loadBoard = vi.fn(async () => true);
const stopLiveRefresh = vi.fn();
const stopLifecycleRefresh = vi.fn();
const syncLifecycle = vi.fn(async () => undefined);

await import("./workboard-page.ts");

type WorkboardPageTestElement = HTMLElement & {
  context: ApplicationContext;
  routeData?: WorkboardRouteData;
  updateComplete: Promise<boolean>;
  syncWorkboardAgentScope: () => void;
  syncWorkboardBoardFilter: () => void;
};

function contextWithWorkboard(workboard: WorkboardCapability): ApplicationContext {
  const snapshot: ApplicationGatewaySnapshot = {
    client: null,
    phase: "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
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

beforeEach(() => {
  vi.spyOn(workboardLib, "configureWorkboardLiveRefresh").mockImplementation(configureLiveRefresh);
  vi.spyOn(workboardLib, "handleWorkboardChanged").mockImplementation(handleChanged);
  vi.spyOn(workboardLib, "loadWorkboard").mockImplementation(loadBoard);
  vi.spyOn(workboardLib, "stopWorkboardLifecycleRefresh").mockImplementation(stopLifecycleRefresh);
  vi.spyOn(workboardLib, "stopWorkboardLiveRefresh").mockImplementation(stopLiveRefresh);
  vi.spyOn(workboardLib, "syncWorkboardLifecycle").mockImplementation(syncLifecycle);
});

afterEach(() => {
  document.body.replaceChildren();
  configureLiveRefresh.mockReset().mockReturnValue(false);
  loadBoard.mockClear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
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
    context.gateway.snapshot.phase = "connected";
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

  it("ignores snapshot and invalidation callbacks retained by a retired Gateway", async () => {
    const firstWorkboard = createWorkboardCapability();
    const secondWorkboard = createWorkboardCapability();
    const firstContext = contextWithWorkboard(firstWorkboard);
    const secondContext = contextWithWorkboard(secondWorkboard);
    let retiredSnapshot: Parameters<typeof firstContext.gateway.subscribe>[0] | undefined;
    let retiredEvent: Parameters<typeof firstContext.gateway.subscribeEvents>[0] | undefined;
    firstContext.gateway.subscribe = (listener) => {
      retiredSnapshot = listener;
      return () => undefined;
    };
    firstContext.gateway.subscribeEvents = (listener) => {
      retiredEvent = listener;
      return () => undefined;
    };
    firstContext.gateway.snapshot.phase = "connected";
    firstContext.gateway.snapshot.client = { request: vi.fn() } as never;
    secondContext.gateway.snapshot.phase = "connected";
    secondContext.gateway.snapshot.client = { request: vi.fn() } as never;
    const page = document.createElement("openclaw-workboard-page") as WorkboardPageTestElement;
    page.context = firstContext;
    document.body.append(page);
    await page.updateComplete;

    page.context = secondContext;
    (page as unknown as { requestUpdate: () => void }).requestUpdate();
    await page.updateComplete;
    vi.clearAllMocks();

    retiredSnapshot?.({ ...firstContext.gateway.snapshot, phase: "stopped", client: null });
    retiredEvent?.({
      type: "event",
      event: "plugin.workboard.changed",
      payload: { epoch: "retired", revision: 1 },
    });

    expect(stopLiveRefresh).not.toHaveBeenCalledWith(secondWorkboard);
    expect(stopLifecycleRefresh).not.toHaveBeenCalledWith(secondWorkboard);
    expect(handleChanged).not.toHaveBeenCalled();
  });

  it("forces one canonical reload when the live client is newly installed", async () => {
    const workboard = createWorkboardCapability();
    const context = contextWithWorkboard(workboard);
    context.gateway.snapshot.phase = "connected";
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
    context.gateway.snapshot.phase = "connected";
    context.gateway.snapshot.client = { request: vi.fn() } as never;
    const page = document.createElement("openclaw-workboard-page") as WorkboardPageTestElement;
    page.context = context;
    document.body.append(page);
    await page.updateComplete;
    vi.clearAllMocks();

    snapshotListener?.({ ...context.gateway.snapshot, phase: "stopped", client: null });

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

  it.each([
    { boardFilter: "product", remainsVisible: false },
    { boardFilter: "__all__", remainsVisible: true },
  ])(
    "reconciles existing card overlays when the board route changes to $boardFilter",
    async ({ boardFilter, remainsVisible }) => {
      const workboard = createWorkboardCapability();
      const page = document.createElement("openclaw-workboard-page") as WorkboardPageTestElement;
      page.context = contextWithWorkboard(workboard);
      document.body.append(page);
      await page.updateComplete;
      workboard.state.cards = [
        {
          id: "ops-card",
          title: "Operations task",
          status: "todo",
          priority: "normal",
          labels: [],
          position: 1000,
          createdAt: 1,
          updatedAt: 1,
          metadata: { automation: { boardId: "ops" } },
        },
      ];
      workboard.state.boardFilter = "ops";
      workboard.state.detailCardId = "ops-card";
      workboard.state.detailCommentBody = "draft comment";
      workboard.state.draftOpen = true;
      workboard.state.editingCardId = "ops-card";
      page.routeData = { boardFilter, search: "" };

      page.syncWorkboardBoardFilter();

      expect(workboard.state.boardFilter).toBe(boardFilter);
      expect(workboard.state.detailCardId).toBe(remainsVisible ? "ops-card" : null);
      expect(workboard.state.detailCommentBody).toBe(remainsVisible ? "draft comment" : "");
      expect(workboard.state.draftOpen).toBe(remainsVisible);
      expect(workboard.state.editingCardId).toBe(remainsVisible ? "ops-card" : null);
    },
  );

  it("preserves a new-card draft when the board route changes", async () => {
    const workboard = createWorkboardCapability();
    const page = document.createElement("openclaw-workboard-page") as WorkboardPageTestElement;
    page.context = contextWithWorkboard(workboard);
    document.body.append(page);
    await page.updateComplete;
    workboard.state.boardFilter = "ops";
    workboard.state.draftOpen = true;
    workboard.state.draftTitle = "New operations task";
    page.routeData = { boardFilter: "product", search: "" };

    page.syncWorkboardBoardFilter();

    expect(workboard.state.boardFilter).toBe("product");
    expect(workboard.state.draftOpen).toBe(true);
    expect(workboard.state.draftTitle).toBe("New operations task");
    expect(workboard.state.editingCardId).toBeNull();
  });

  it.each([
    ["job-categorize-planning", true],
    [undefined, false],
  ])("renders the automation chip only for linked boards", async (automationJobId, visible) => {
    const workboard = createWorkboardCapability();
    workboard.state.boards = [
      {
        id: "planning",
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
        ...(automationJobId ? { automationJobId } : {}),
      },
    ];
    const page = document.createElement("openclaw-workboard-page") as WorkboardPageTestElement;
    page.context = contextWithWorkboard(workboard);
    page.routeData = { boardFilter: "planning", search: "" };
    document.body.append(page);
    await page.updateComplete;

    const chip = page.querySelector<HTMLAnchorElement>(".workboard-automation-chip");
    expect(Boolean(chip)).toBe(visible);
    if (visible) {
      expect(chip?.getAttribute("href")).toBe("/automations");
      expect(chip?.getAttribute("title")).toBe("Open Automations");
      expect(chip?.getAttribute("aria-label")).toBe("Open Automations");
      expect(chip?.textContent?.trim()).toBe("Automation");
    }
  });
});
