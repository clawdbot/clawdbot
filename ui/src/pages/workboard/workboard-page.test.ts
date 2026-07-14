import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createWorkboardCapability } from "../../lib/workboard/capability.ts";
import type { WorkboardCapability } from "../../lib/workboard/capability.ts";

const { stopPolling, stopLifecycleRefresh } = vi.hoisted(() => ({
  stopPolling: vi.fn(),
  stopLifecycleRefresh: vi.fn(),
}));

vi.mock("../../lib/workboard/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workboard/index.ts")>()),
  configureWorkboardPolling: vi.fn(),
  loadWorkboard: vi.fn(async () => true),
  stopWorkboardLifecycleRefresh: stopLifecycleRefresh,
  stopWorkboardPolling: stopPolling,
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
    gateway: { snapshot, subscribe } as unknown as ApplicationContext["gateway"],
    agents: {
      state: { agentsList: null, agentsLoading: false },
      subscribe,
    } as unknown as ApplicationContext["agents"],
    runtimeConfig: {
      state: {
        configSnapshot: {
          config: { plugins: { entries: { workboard: { enabled: true } } } },
        },
        configLoading: false,
      },
      subscribe,
    } as unknown as ApplicationContext["runtimeConfig"],
    sessions: {
      state: { result: null, loading: false },
      subscribe,
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
  vi.clearAllMocks();
});

describe("WorkboardPage lifecycle", () => {
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

    expect(stopPolling).toHaveBeenCalledWith(first);
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
