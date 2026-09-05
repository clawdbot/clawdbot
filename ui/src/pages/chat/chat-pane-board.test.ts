/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createApplicationTheme } from "../../app/bootstrap-theme.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createGatewayStoreTestStore } from "../../app/gateway-store.test-support.ts";
import { loadSettings, patchSettings, saveSettings } from "../../app/settings.ts";
import {
  acquireBoardProviderForSession,
  boardProviderForSession,
  type BoardCommandEvent,
  type BoardProvider,
} from "../../lib/board/provider.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "./chat-pane.ts";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { createInitialChatRealtimeState } from "./chat-realtime.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import {
  closeSlot,
  openSlot,
  promoteSidebarPanel,
  setSidebarDock,
  sidebarActivePanel,
  sidebarMainPanel,
} from "./sidebar-layout.ts";

const swarmModuleImport = vi.hoisted(() => {
  let markStarted!: () => void;
  let release!: () => void;
  return {
    started: new Promise<void>((resolve) => {
      markStarted = resolve;
    }),
    pending: new Promise<void>((resolve) => {
      release = resolve;
    }),
    markStarted,
    release,
  };
});

vi.mock("../../lib/sessions/swarm-roster.ts", async (importOriginal) => {
  swarmModuleImport.markStarted();
  await swarmModuleImport.pending;
  return importOriginal();
});

type TestChatPane = HTMLElement & {
  boardProvider?: BoardProvider;
  connectedClient: GatewayBrowserClient | null;
  connectionGeneration: number;
  context: ApplicationContext;
  state: ChatPageHost;
  createSession: () => Promise<boolean>;
  paneId: string;
  presented: boolean;
  visuallyPresented: boolean;
  readonly conversationPresented: boolean;
  presentedChanged: (presented: boolean) => void;
  sessionKey: string;
  resetConfirmationOpen: boolean;
  routeFace: "chat" | "dashboard";
  dashboardExpanded: boolean;
  onFaceChange?: (paneId: string, sessionKey: string, face: "chat" | "dashboard") => void;
  confirmConversationReset: () => Promise<boolean>;
  commitSidebarLayout: (layout: ChatPageHost["sidebarLayout"]) => void;
  settleResetConfirmation: (confirmed: boolean) => void;
  updated: () => void;
  handleBoardCommand: (event: BoardCommandEvent) => void;
  showDashboard: (expanded: boolean) => void;
  persistBoardSessionView: (patch: { face?: "chat" | "dashboard"; activeTabId?: string }) => void;
  resolveBoardProvider: () => BoardProvider;
  resolveBoardView: () => ResolvedBoardView;
  syncRetainedBoardSession: (board: ResolvedBoardView) => void;
  refreshSwarmRoster: () => void;
  requestUpdate: () => void;
};

type MockProvider = BoardProvider & { emitCommand(command: BoardCommandEvent["command"]): void };

function mockBoardProvider(sessionKey: string): MockProvider {
  return boardProviderForSession({ sessionKey }) as MockProvider;
}

function nullBoardProvider(sessionKey: string): BoardProvider {
  window.history.replaceState({}, "", "/");
  return boardProviderForSession({ sessionKey });
}

let theme: ReturnType<typeof createApplicationTheme>;

function createTestPane(sessions: SessionCapability = {} as SessionCapability) {
  const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
  const client = {} as GatewayBrowserClient;
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  pane.context = {
    theme,
    sessions,
    gateway: { snapshot: { client, phase: "connected", hello: sessionMutationGatewayHello() } },
  } as unknown as ApplicationContext;
  pane.state = {
    ...createInitialChatRealtimeState(),
    chatError: null,
    chatLoading: false,
    chatMessages: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    client,
    connected: true,
    lastError: null,
    renderLifecycle: { afterCommit: () => () => {}, invalidate: () => {} },
    requestUpdate: vi.fn(),
    sessionKey: "agent:main:current",
    sidebarFocusPanelId: "",
    sidebarFocusVersion: 0,
    sidebarLayout: { columns: [] },
    sessions,
    sessionsError: null,
    sessionsLoading: false,
  } as unknown as ChatPageHost;
  pane.state.updateSidebarLayout = (layout) => {
    pane.state.sidebarLayout = layout;
  };
  pane.state.updateSidebarActivePanel = (panelId) => {
    pane.state.sidebarFocusPanelId = panelId;
    pane.state.sidebarFocusVersion += 1;
  };
  pane.connectedClient = client;
  pane.connectionGeneration = 1;
  return pane;
}

function createGatewayBoardPane(params: {
  sessionKey: string;
  methods?: readonly string[];
  scopes?: readonly string[];
  capabilities?: readonly string[];
  lifecycleConnected?: boolean;
}) {
  window.history.replaceState({}, "", "/");
  const pane = createTestPane();
  const snapshot = { sessionKey: params.sessionKey, revision: 1, tabs: [], widgets: [] };
  const removeListener = vi.fn();
  const request = vi.fn<
    (
      method: string,
      params: { sessionKey: string; agentId?: string },
    ) => Promise<BoardProvider["snapshot$"]["value"]>
  >(async () => snapshot);
  const addEventListener = vi.fn(() => removeListener);
  const client = { request, addEventListener } as unknown as GatewayBrowserClient;
  pane.state.sessionKey = params.sessionKey;
  pane.state.client = client;
  Reflect.set(pane, "boardProviderLifecycleConnected", params.lifecycleConnected ?? true);
  pane.context = {
    ...pane.context,
    gateway: {
      snapshot: {
        client,
        phase: "connected",
        hello: {
          ...(params.scopes ? { auth: { role: "operator", scopes: params.scopes } } : {}),
          features: {
            methods: params.methods ?? ["board.get"],
            ...(params.capabilities ? { capabilities: params.capabilities } : {}),
          },
        },
      },
    },
  } as unknown as ApplicationContext;
  return { pane, snapshot, client, request, addEventListener, removeListener };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  window.history.replaceState({}, "", "/?mockBoard=1");
  const settings = loadSettings();
  theme = createApplicationTheme(settings, createGatewayStoreTestStore({ settings }).gateway);
});

afterEach(() => {
  theme.dispose();
  vi.restoreAllMocks();
  saveSettings(loadSettings());
  window.history.replaceState({}, "", "/");
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("chat pane board shell", () => {
  it.each(["agent:main:closed-dashboard", "global"])(
    "keeps an explicitly closed empty dashboard closed when its first content arrives (%s)",
    async (sessionKey) => {
      const { pane, request } = createGatewayBoardPane({ sessionKey });
      pane.sessionKey = sessionKey;
      pane.routeFace = "chat";
      pane.onFaceChange = vi.fn();
      if (sessionKey === "global") {
        pane.state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
        pane.state.assistantAgentId = "work";
      }
      const snapshotKey = sessionKey === "global" ? "agent:work:global" : sessionKey;
      request.mockResolvedValue({ sessionKey: snapshotKey, revision: 1, tabs: [], widgets: [] });
      const provider = pane.resolveBoardProvider();
      try {
        await vi.waitFor(() => expect(provider.hasLoadedSnapshot).toBe(true));
        pane.syncRetainedBoardSession(pane.resolveBoardView());
        const closed = closeSlot(openSlot({ columns: [] }, "dashboard"), "dashboard");
        pane.commitSidebarLayout(closed);
        patchSettings({ sidebarSessionLayouts: { [sessionKey]: closed } });
        request.mockResolvedValue({
          sessionKey: snapshotKey,
          revision: 2,
          tabs: [{ tabId: "main", title: "Overview", position: 0, chatDock: "right" }],
          widgets: [],
        });
        await provider.applyOps([{ kind: "tab_create", tabId: "main", title: "Overview" }]);
        pane.syncRetainedBoardSession(pane.resolveBoardView());
        expect(pane.state.sidebarLayout).toEqual(closed);
        expect(pane.onFaceChange).not.toHaveBeenCalled();
      } finally {
        (Reflect.get(pane, "releaseBoardProviderLease") as () => void).call(pane);
      }
    },
  );

  it("keeps side-panel presentation independent from persisted Board data", () => {
    const pane = createTestPane();
    const provider = mockBoardProvider("agent:main:current");
    const applyOps = vi.spyOn(provider, "applyOps");
    pane.boardProvider = provider;
    pane.commitSidebarLayout(openSlot(pane.state.sidebarLayout, "terminal"));
    pane.commitSidebarLayout({ ...pane.state.sidebarLayout, open: false });
    expect(applyOps).not.toHaveBeenCalled();
  });

  it("opens split view once when the current task first gains a dashboard", async () => {
    const pane = createTestPane();
    const provider = mockBoardProvider("agent:main:first-dashboard");
    pane.state.sessionKey = "agent:main:first-dashboard";
    pane.sessionKey = "agent:main:first-dashboard";
    pane.boardProvider = provider;
    pane.routeFace = "chat";
    pane.onFaceChange = vi.fn();
    await provider.applyOps([
      { kind: "widget_remove", name: "session-status" },
      { kind: "widget_remove", name: "recent-findings" },
      { kind: "widget_remove", name: "source-map" },
      { kind: "tab_delete", tabId: "main" },
      { kind: "tab_delete", tabId: "research" },
    ]);
    pane.syncRetainedBoardSession(pane.resolveBoardView());

    await provider.applyOps([{ kind: "tab_create", tabId: "main", title: "Dashboard" }]);
    pane.syncRetainedBoardSession(pane.resolveBoardView());

    expect(
      pane.state.sidebarLayout.columns.flatMap((column) =>
        column.panels.map((panel) => panel.slot),
      ),
    ).toContain("dashboard");
    expect(pane.state.sidebarLayout.expanded).toBe(false);
    expect(pane.onFaceChange).toHaveBeenCalledOnce();

    pane.syncRetainedBoardSession(pane.resolveBoardView());
    expect(pane.onFaceChange).toHaveBeenCalledOnce();
  });

  it("publishes conversation presentation per pane without overwriting shared session state", () => {
    const first = createTestPane();
    const second = createTestPane();
    second.state = first.state;
    const provider = mockBoardProvider(first.state.sessionKey);
    first.boardProvider = provider;
    second.boardProvider = provider;
    const changed = vi.fn();
    first.addEventListener("openclaw-chat-pane-lifecycle-changed", changed);
    first.updated();
    second.updated();
    expect(first.conversationPresented).toBe(true);
    expect(second.conversationPresented).toBe(true);
    expect(changed).toHaveBeenCalledOnce();

    first.visuallyPresented = false;
    expect(first.conversationPresented).toBe(false);
    expect(second.conversationPresented).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    first.presented = false;
    first.visuallyPresented = true;
    expect(first.conversationPresented).toBe(false);
    first.updated();
    expect(second.conversationPresented).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it.each(["terminal", "dashboard"] as const)(
    "applies a focused dashboard link over saved %s main only once",
    (slot) => {
      const pane = createTestPane();
      pane.boardProvider = mockBoardProvider("agent:main:expanded-route");
      pane.state.sessionKey = "agent:main:expanded-route";
      pane.sessionKey = "agent:main:expanded-route";
      pane.routeFace = "dashboard";
      pane.dashboardExpanded = true;
      const savedLayout = {
        ...promoteSidebarPanel(openSlot({ columns: [] }, slot), slot),
        open: false,
      };
      pane.state.sidebarLayout = savedLayout;
      patchSettings({ sidebarSessionLayouts: { [pane.sessionKey]: savedLayout } });

      pane.updated();
      expect(pane.conversationPresented).toBe(false);
      expect(pane.state.sidebarLayout.expanded).toBe(true);
      expect(pane.state.sidebarLayout.open).toBe(true);
      expect(sidebarMainPanel(pane.state.sidebarLayout)?.slot).toBe("dashboard");
      expect(sidebarActivePanel(pane.state.sidebarLayout)?.slot).toBe(
        slot === "dashboard" ? "conversation" : "terminal",
      );

      pane.state.sidebarLayout = { ...pane.state.sidebarLayout, expanded: false };
      pane.updated();
      expect(pane.state.sidebarLayout.expanded).toBe(false);
      expect(pane.conversationPresented).toBe(slot === "dashboard");
    },
  );

  it.each([true, false])(
    "restores saved task layout with side panel open=%s on an ordinary dashboard revisit",
    (open) => {
      const pane = createTestPane();
      pane.state.sessionKey = "agent:main:saved-dashboard-layout";
      pane.sessionKey = pane.state.sessionKey;
      pane.boardProvider = mockBoardProvider(pane.sessionKey);
      pane.routeFace = "dashboard";
      pane.onFaceChange = vi.fn();
      const savedLayout = {
        ...setSidebarDock(
          promoteSidebarPanel(
            openSlot(openSlot({ columns: [] }, "dashboard"), "terminal"),
            "terminal",
          ),
          "left",
        ),
        open,
      };
      pane.state.sidebarLayout = savedLayout;
      patchSettings({ sidebarSessionLayouts: { [pane.sessionKey]: savedLayout } });

      pane.syncRetainedBoardSession(pane.resolveBoardView());

      expect(pane.state.sidebarLayout).toEqual(savedLayout);
      expect(pane.onFaceChange).not.toHaveBeenCalled();
    },
  );

  it("opens a dashboard route in split view only once", () => {
    const pane = createTestPane();
    pane.boardProvider = mockBoardProvider("agent:main:dashboard-route");
    pane.state.sessionKey = "agent:main:dashboard-route";
    pane.sessionKey = "agent:main:dashboard-route";
    pane.routeFace = "dashboard";
    pane.commitSidebarLayout(openSlot(pane.state.sidebarLayout, "terminal"));

    pane.syncRetainedBoardSession(pane.resolveBoardView());
    expect(
      pane.state.sidebarLayout.columns.flatMap(
        (column) => column.panels.find((panel) => panel.id === column.activePanelId)?.slot,
      ),
    ).toContain("dashboard");
    expect(pane.state.sidebarLayout.expanded).toBe(false);

    pane.commitSidebarLayout(openSlot(pane.state.sidebarLayout, "terminal"));
    pane.syncRetainedBoardSession(pane.resolveBoardView());
    expect(
      pane.state.sidebarLayout.columns.flatMap(
        (column) => column.panels.find((panel) => panel.id === column.activePanelId)?.slot,
      ),
    ).toContain("terminal");
  });

  it("does not hydrate the swarm after becoming hidden during module loading", async () => {
    vi.useFakeTimers();
    const list = vi.fn().mockResolvedValue({ sessions: [] });
    const sessions = { canonicalListRevision: 0, list } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    pane.context = {
      ...pane.context,
      runtimeConfig: {
        state: { configSnapshot: { config: {} } },
      },
    } as unknown as ApplicationContext;
    pane.presentedChanged = () => undefined;

    try {
      pane.refreshSwarmRoster();
      await swarmModuleImport.started;
      pane.presented = false;
      swarmModuleImport.release();
      await import("../../lib/sessions/swarm-roster.ts");
      await Promise.resolve();
      await vi.runAllTimersAsync();

      expect(list).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["disabled", "disposed", "enabled", "default"] as const)(
    "coalesces swarm roster redraws while %s",
    async (mode) => {
      swarmModuleImport.release();
      const { SwarmRosterHydrator } = await import("../../lib/sessions/swarm-roster.ts");
      const pane = createTestPane({
        canonicalListRevision: 0,
        list: vi.fn(async () => ({ sessions: [] })),
      } as unknown as SessionCapability);
      pane.context = {
        ...pane.context,
        runtimeConfig: {
          state: {
            configSnapshot: {
              config:
                mode === "default" ? {} : { tools: { swarm: { enabled: mode === "enabled" } } },
            },
          },
        },
      } as unknown as ApplicationContext;
      const previous = mode === "disposed" ? new SwarmRosterHydrator() : null;
      const dispose = previous ? vi.spyOn(previous, "dispose") : undefined;
      Reflect.set(pane, "swarmHydrator", previous);
      await vi.dynamicImportSettled();
      const frames: FrameRequestCallback[] = [];
      const requestFrame = vi.fn((callback: FrameRequestCallback) => frames.push(callback));
      vi.stubGlobal("requestAnimationFrame", requestFrame);
      const requestUpdate = vi.spyOn(pane, "requestUpdate");

      try {
        for (let index = 0; index < 3; index += 1) {
          pane.refreshSwarmRoster();
        }
        await vi.dynamicImportSettled();

        expect(requestUpdate).not.toHaveBeenCalled();
        expect(pane.state.requestUpdate).not.toHaveBeenCalled();
        expect(requestFrame).toHaveBeenCalledTimes(mode === "disabled" ? 0 : 1);
        if (mode !== "disabled") {
          frames[0]?.(0);
          expect(pane.state.requestUpdate).toHaveBeenCalledOnce();
        }
        if (dispose) {
          expect(dispose).toHaveBeenCalledOnce();
          expect(Reflect.get(pane, "swarmHydrator")).toBeNull();
        } else if (mode === "enabled" || mode === "default") {
          expect(Reflect.get(pane, "swarmHydrator")).toBeInstanceOf(SwarmRosterHydrator);
        }
      } finally {
        const hydrator = Reflect.get(pane, "swarmHydrator") as InstanceType<
          typeof SwarmRosterHydrator
        > | null;
        hydrator?.dispose();
      }
    },
  );

  it("gates New Chat when the current session has a board", async () => {
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
    } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    pane.boardProvider = mockBoardProvider("agent:main:current");

    const pending = pane.createSession();
    await Promise.resolve();

    expect(pane.resetConfirmationOpen).toBe(true);
    expect(sessions.create).not.toHaveBeenCalled();
    pane.settleResetConfirmation(false);
    await expect(pending).resolves.toBe(false);
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("resets a board-bearing session in place so its dashboard stays", async () => {
    const reset = vi.fn(async () => "completed" as const);
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
      reset,
    } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return { messages: [] };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    pane.state.client = client;
    pane.context = {
      ...pane.context,
      gateway: { snapshot: { client, phase: "connected", hello: sessionMutationGatewayHello() } },
    } as unknown as ApplicationContext;
    pane.connectedClient = client;
    pane.boardProvider = mockBoardProvider("agent:main:current");

    const pending = pane.createSession();
    await Promise.resolve();
    pane.settleResetConfirmation(true);

    await expect(pending).resolves.toBe(true);
    expect(reset).toHaveBeenCalledWith("agent:main:current", {});
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("rechecks reset scope after board confirmation", async () => {
    const reset = vi.fn(async () => "completed" as const);
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
      reset,
    } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.admin"] },
      features: { methods: ["sessions.reset"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    pane.boardProvider = mockBoardProvider("agent:main:current");

    const pending = pane.createSession();
    await Promise.resolve();
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.reset"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    pane.settleResetConfirmation(true);

    await expect(pending).resolves.toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(pane.state.lastError).toContain("operator.admin");
    expect(pane.state.chatError).toBe(pane.state.lastError);
  });

  it("does not reset when a run starts during confirmation", async () => {
    const reset = vi.fn(async () => "completed" as const);
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
      reset,
    } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    pane.boardProvider = mockBoardProvider("agent:main:current");

    const pending = pane.createSession();
    await Promise.resolve();
    pane.state.chatRunId = "run-started-during-confirmation";
    pane.settleResetConfirmation(true);

    await expect(pending).resolves.toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it("cancels New Chat when the selected session changes during confirmation", async () => {
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
      reset: vi.fn(async () => "completed" as const),
    } as unknown as SessionCapability;
    const pane = createTestPane(sessions);
    pane.boardProvider = mockBoardProvider("agent:main:current");

    const pending = pane.createSession();
    await Promise.resolve();
    pane.state.sessionKey = "agent:main:other";
    pane.updated();

    await expect(pending).resolves.toBe(false);
    expect(pane.resetConfirmationOpen).toBe(false);
    expect(sessions.create).not.toHaveBeenCalled();
    expect(sessions.reset).not.toHaveBeenCalled();
  });

  it("does not share reset confirmation across sessions", async () => {
    const pane = createTestPane();
    pane.boardProvider = mockBoardProvider("agent:main:first");
    pane.state.sessionKey = "agent:main:first";

    const first = pane.confirmConversationReset();
    pane.state.sessionKey = "agent:main:second";
    pane.boardProvider = mockBoardProvider("agent:main:second");
    const second = pane.confirmConversationReset();

    await expect(first).resolves.toBe(false);
    expect(pane.resetConfirmationOpen).toBe(true);
    pane.settleResetConfirmation(true);
    await expect(second).resolves.toBe(true);
  });

  it("keeps global dashboard reset confirmation open until its owner changes", async () => {
    const { pane, request } = createGatewayBoardPane({ sessionKey: "global" });
    pane.state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
    pane.state.assistantAgentId = "work";
    request.mockResolvedValue({
      sessionKey: "agent:work:global",
      revision: 1,
      tabs: [{ tabId: "overview", title: "Work", position: 0, chatDock: "right" }],
      widgets: [],
    });
    try {
      const provider = pane.resolveBoardProvider();
      await vi.waitFor(() => expect(provider.snapshot$.value.revision).toBe(1));
      const pending = pane.confirmConversationReset();
      pane.updated();
      expect(pane.resetConfirmationOpen).toBe(true);
      pane.state.assistantAgentId = "main";
      pane.updated();
      await expect(pending).resolves.toBe(false);
      expect(pane.resetConfirmationOpen).toBe(false);
    } finally {
      pane.settleResetConfirmation(false);
      (Reflect.get(pane, "releaseBoardProviderLease") as () => void).call(pane);
    }
  });

  it("keeps chat-only reset confirmation disabled", async () => {
    const pane = createTestPane();
    pane.boardProvider = nullBoardProvider("agent:main:current");

    await expect(pane.confirmConversationReset()).resolves.toBe(true);
    expect(pane.resetConfirmationOpen).toBe(false);
  });

  it("maps transient Board presentation commands onto the dashboard panel", () => {
    const pane = createTestPane();
    const provider = mockBoardProvider("agent:main:current");
    pane.boardProvider = provider;
    pane.onFaceChange = vi.fn();
    const unsubscribe = provider.events.subscribe((event) => pane.handleBoardCommand(event));

    provider.emitCommand({ kind: "set_chat_dock", dock: "left" });
    expect(
      pane.state.sidebarLayout.columns.flatMap((column) =>
        column.panels.map((panel) => panel.slot),
      ),
    ).toContain("dashboard");
    expect(pane.state.sidebarLayout.expanded).toBe(false);

    provider.emitCommand({ kind: "set_chat_dock", dock: "hidden" });
    expect(pane.state.sidebarLayout.expanded).toBe(true);
    expect(sidebarMainPanel(pane.state.sidebarLayout)?.slot).toBe("dashboard");
    expect(sidebarActivePanel(pane.state.sidebarLayout)?.slot).toBe("conversation");
    provider.emitCommand({ kind: "set_chat_dock", dock: "right" });
    expect(sidebarMainPanel(pane.state.sidebarLayout)?.slot).toBe("dashboard");
    expect(sidebarActivePanel(pane.state.sidebarLayout)?.slot).toBe("conversation");
    expect(pane.state.sidebarLayout.expanded).toBe(false);
    expect(pane.onFaceChange).toHaveBeenLastCalledWith(pane.paneId, pane.sessionKey, "dashboard");
    unsubscribe();
  });

  it("restores one board view across equivalent main session keys", () => {
    const pane = createTestPane();
    pane.context = {
      ...pane.context,
      gateway: {
        ...pane.context.gateway,
        snapshot: {
          ...pane.context.gateway.snapshot,
          hello: {
            snapshot: {
              sessionDefaults: {
                defaultAgentId: "main",
                mainKey: "main",
                mainSessionKey: "agent:main:main",
              },
            },
          } as never,
        },
      },
    };
    pane.state.sessionKey = "agent:main:main";
    pane.boardProvider = mockBoardProvider("main");
    pane.routeFace = "dashboard";
    pane.persistBoardSessionView({ activeTabId: "research" });

    pane.boardProvider = mockBoardProvider("agent:main:main");

    expect(pane.resolveBoardView()).toMatchObject({
      activeTabId: "research",
      face: "dashboard",
    });
  });

  it("routes face changes through the owning retained presentation", () => {
    const pane = createTestPane();
    pane.paneId = "pane-1";
    pane.sessionKey = "agent:main:retained";
    const onFaceChange = vi.fn();
    pane.onFaceChange = onFaceChange;

    pane.persistBoardSessionView({ face: "dashboard" });

    expect(onFaceChange).toHaveBeenCalledWith("pane-1", "agent:main:retained", "dashboard");
  });

  it("uses in-memory tab preferences while the route owns the face", () => {
    const pane = createTestPane();
    pane.routeFace = "dashboard";
    pane.boardProvider = mockBoardProvider("agent:main:current");
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    patchSettings({
      boardSessionViews: {
        "agent:main:current": { activeTabId: "research" },
      },
    });

    expect(pane.resolveBoardView()).toMatchObject({
      activeTabId: "research",
      face: "dashboard",
    });

    pane.persistBoardSessionView({ activeTabId: "main" });
    expect(pane.resolveBoardView()).toMatchObject({
      activeTabId: "main",
      face: "dashboard",
    });
  });

  it("preserves preferences saved by another split pane", () => {
    const initialSettings = patchSettings({
      boardSessionViews: {
        "agent:main:first": { activeTabId: "main" },
      },
    });
    const firstPane = createTestPane();
    firstPane.routeFace = "dashboard";
    firstPane.state.sessionKey = "agent:main:first";
    firstPane.state.settings = initialSettings;
    firstPane.boardProvider = mockBoardProvider("agent:main:first");
    const secondPane = createTestPane();
    secondPane.routeFace = "dashboard";
    secondPane.state.sessionKey = "agent:main:second";
    secondPane.state.settings = initialSettings;
    secondPane.boardProvider = mockBoardProvider("agent:main:second");

    firstPane.persistBoardSessionView({ activeTabId: "research" });

    secondPane.state.sessionKey = "agent:main:first";
    secondPane.boardProvider = mockBoardProvider("agent:main:first");
    expect(secondPane.resolveBoardView()).toMatchObject({
      face: "dashboard",
      activeTabId: "research",
    });

    secondPane.state.sessionKey = "agent:main:second";
    secondPane.boardProvider = mockBoardProvider("agent:main:second");
    secondPane.persistBoardSessionView({ activeTabId: "main" });

    expect(loadSettings().boardSessionViews).toMatchObject({
      "agent:main:first": { activeTabId: "research" },
      "agent:main:second": { activeTabId: "main" },
    });
  });

  it("resolves configured main aliases before selecting a provider", () => {
    const pane = createTestPane();
    pane.state.sessionKey = "primary";
    pane.context = {
      ...pane.context,
      gateway: {
        ...pane.context.gateway,
        snapshot: {
          ...pane.context.gateway.snapshot,
          hello: {
            snapshot: {
              sessionDefaults: {
                defaultAgentId: "work",
                mainKey: "primary",
                mainSessionKey: "agent:work:primary",
              },
            },
          } as never,
        },
      },
    };

    expect(pane.resolveBoardProvider().snapshot$.value.sessionKey).toBe("agent:work:primary");
  });

  it("keeps global board leases scoped through owner switches, second panes, and acknowledgments", async () => {
    const { pane, client, request, addEventListener, removeListener } = createGatewayBoardPane({
      sessionKey: "agent:main:main",
    });
    const configure = (target: TestChatPane, agentId: string) => {
      target.state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
      target.state.assistantAgentId = agentId;
      target.state.sessionKey = "global";
    };
    request.mockImplementation(
      async (_method: string, params: { sessionKey: string; agentId?: string }) => ({
        sessionKey:
          params.sessionKey === "global" ? `agent:${params.agentId}:global` : params.sessionKey,
        revision: 1,
        tabs: [
          {
            tabId: "overview",
            title: params.agentId ?? "missing owner",
            position: 0,
            chatDock: "right" as const,
          },
        ],
        widgets: [],
      }),
    );
    configure(pane, "main");
    const second = createTestPane();
    second.context = pane.context;
    second.state.client = client;
    Reflect.set(second, "boardProviderLifecycleConnected", true);
    configure(second, "main");
    const release = (target: TestChatPane) =>
      (Reflect.get(target, "releaseBoardProviderLease") as () => void).call(target);
    try {
      const main = pane.resolveBoardProvider();
      const shared = second.resolveBoardProvider();
      await vi.waitFor(() => expect(main.snapshot$.value.tabs).toHaveLength(1));
      expect(request).toHaveBeenLastCalledWith("board.get", {
        sessionKey: "global",
        agentId: "main",
      });
      expect(shared.snapshot$).toBe(main.snapshot$);
      expect(addEventListener).toHaveBeenCalledTimes(1);

      configure(pane, "work");
      const work = pane.resolveBoardProvider();
      await vi.waitFor(() => expect(work.snapshot$.value.tabs[0]?.title).toBe("work"));
      expect(request).toHaveBeenLastCalledWith("board.get", {
        sessionKey: "global",
        agentId: "work",
      });
      expect(shared.snapshot$.value.tabs[0]?.title).toBe("main");
      expect(work.snapshot$).not.toBe(main.snapshot$);
      expect(pane.resolveBoardProvider()).toBe(work);
      expect(removeListener).not.toHaveBeenCalled();

      release(second);
      expect(removeListener).toHaveBeenCalledTimes(1);
      release(pane);
      expect(removeListener).toHaveBeenCalledTimes(2);
      const reacquired = pane.resolveBoardProvider();
      await vi.waitFor(() => expect(reacquired.snapshot$.value.tabs[0]?.title).toBe("work"));
      expect(reacquired.snapshot$).not.toBe(work.snapshot$);
      expect(request).toHaveBeenLastCalledWith("board.get", {
        sessionKey: "global",
        agentId: "work",
      });
    } finally {
      release(pane);
      release(second);
    }
  });

  it("does not subscribe to a gateway board before the pane owns a lifecycle lease", async () => {
    const sessionKey = "agent:main:board-lifecycle-ownership";
    const { pane, snapshot, request, addEventListener, removeListener } = createGatewayBoardPane({
      sessionKey,
      scopes: ["operator.read", "operator.write"],
      lifecycleConnected: false,
    });

    expect(pane.resolveBoardProvider().snapshot$.value.sessionKey).toBe(sessionKey);
    expect(request).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();

    Reflect.set(pane, "boardProviderLifecycleConnected", true);
    const provider = pane.resolveBoardProvider();
    try {
      await vi.waitFor(() => expect(provider.snapshot$.value).toEqual(snapshot));
      expect(request).toHaveBeenCalledOnce();
      expect(addEventListener).toHaveBeenCalledOnce();
    } finally {
      const release = Reflect.get(pane, "releaseBoardProviderLease") as () => void;
      release.call(pane);
    }

    expect(removeListener).toHaveBeenCalledOnce();
  });

  it("keeps gateways without board support on the null provider", () => {
    const { pane, request, addEventListener } = createGatewayBoardPane({
      sessionKey: "agent:main:board-unsupported",
      methods: ["chat.history"],
    });

    expect(pane.resolveBoardProvider()).toMatchObject({
      canMutate: false,
      canGrant: false,
      canPinWidgets: false,
      canPinMcpApps: false,
    });
    expect(request).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it("does not reuse another board lease after gateway board support disappears", () => {
    const sessionKey = "agent:main:board-support-revoked";
    const { pane, client, addEventListener } = createGatewayBoardPane({
      sessionKey,
      methods: ["chat.history"],
    });

    const otherConsumer = acquireBoardProviderForSession({ sessionKey }, client);
    try {
      expect(pane.resolveBoardProvider()).toMatchObject({
        canMutate: false,
        canGrant: false,
        canPinWidgets: false,
        canPinMcpApps: false,
      });
      expect(addEventListener).toHaveBeenCalledOnce();
    } finally {
      otherConsumer.release();
    }
  });

  it("enables MCP App pinning only when app-view and put methods are both advertised", () => {
    const cases = [
      { suffix: "put-only", methods: ["board.get", "board.widget.put"], expected: false },
      { suffix: "view-only", methods: ["board.get", "board.widget.appView"], expected: false },
      {
        suffix: "complete",
        methods: ["board.get", "board.widget.appView", "board.widget.put"],
        expected: true,
      },
    ];

    for (const testCase of cases) {
      const { pane } = createGatewayBoardPane({
        sessionKey: `agent:main:${testCase.suffix}`,
        methods: testCase.methods,
      });
      expect(pane.resolveBoardProvider().canPinMcpApps).toBe(testCase.expected);
    }
  });

  it("updates chat authorization without changing another consumer of the same board", async () => {
    const sessionKey = "agent:main:chat-lease-scope-change";
    const features = {
      methods: ["board.get", "board.widget.appView", "board.widget.put"],
      capabilities: ["board-widget-put-canvas-doc"],
    };
    const { pane, snapshot, client, request, addEventListener, removeListener } =
      createGatewayBoardPane({
        sessionKey,
        scopes: ["operator.read", "operator.write"],
        methods: features.methods,
        capabilities: features.capabilities,
      });
    const chat = pane.resolveBoardProvider();
    const approvals = acquireBoardProviderForSession(
      { sessionKey },
      client,
      true,
      false,
      false,
      false,
      true,
    );

    try {
      await vi.waitFor(() => expect(chat.snapshot$.value).toEqual(snapshot));
      expect(chat).toMatchObject({
        canPinWidgets: true,
        canPinMcpApps: true,
        canMutate: true,
        canGrant: false,
      });
      expect(approvals.provider).toMatchObject({
        canPinWidgets: false,
        canPinMcpApps: false,
        canMutate: false,
        canGrant: true,
      });

      pane.context = {
        ...pane.context,
        gateway: {
          snapshot: {
            client,
            phase: "connected",
            hello: {
              auth: { role: "operator", scopes: ["operator.read"] },
              features,
            },
          },
        },
      } as unknown as ApplicationContext;

      expect(pane.resolveBoardProvider()).toBe(chat);
      expect(chat).toMatchObject({
        canPinWidgets: false,
        canPinMcpApps: false,
        canMutate: false,
        canGrant: false,
      });
      expect(approvals.provider.canGrant).toBe(true);
      expect(approvals.provider.canMutate).toBe(false);
      expect(request).toHaveBeenCalledOnce();
      expect(addEventListener).toHaveBeenCalledOnce();

      approvals.release();
      expect(removeListener).not.toHaveBeenCalled();
      const release = Reflect.get(pane, "releaseBoardProviderLease") as () => void;
      release.call(pane);
      expect(removeListener).toHaveBeenCalledOnce();
    } finally {
      approvals.release();
      const release = Reflect.get(pane, "releaseBoardProviderLease") as () => void;
      release.call(pane);
    }
  });

  it.each([
    {
      profile: "read-only",
      scopes: ["operator.read"],
      canMutate: false,
      canGrant: false,
    },
    {
      profile: "writer with approvals",
      scopes: ["operator.read", "operator.write", "operator.approvals"],
      canMutate: true,
      canGrant: true,
    },
  ])("derives board actions from the $profile connection scopes", (profile) => {
    const { pane } = createGatewayBoardPane({
      sessionKey: `agent:main:scope-${profile.profile.replaceAll(" ", "-")}`,
      scopes: profile.scopes,
      methods: ["board.get", "board.widget.appView", "board.widget.put"],
      capabilities: ["board-widget-put-canvas-doc"],
    });
    const provider = pane.resolveBoardProvider();
    expect(provider.canMutate).toBe(profile.canMutate);
    expect(provider.canGrant).toBe(profile.canGrant);
    expect(provider.canPinWidgets).toBe(profile.canMutate);
    expect(provider.canPinMcpApps).toBe(profile.canMutate);
  });
});
