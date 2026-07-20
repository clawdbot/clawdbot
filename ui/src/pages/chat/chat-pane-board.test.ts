/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { resolveBoardChatLayoutWidth } from "../../lib/board/chat-layout.ts";
import {
  boardProviderForSession,
  type BoardCommandEvent,
  type BoardProvider,
} from "../../lib/board/provider.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import "./chat-pane.ts";
import type { ChatPageHost } from "./chat-state.ts";

type TestChatPane = HTMLElement & {
  boardChatDockSize: { height: number; width: number };
  boardProvider?: BoardProvider;
  connectedClient: GatewayBrowserClient | null;
  connectionGeneration: number;
  context: ApplicationContext;
  state: ChatPageHost;
  createSession: () => Promise<boolean>;
  resetConfirmationOpen: boolean;
  confirmConversationReset: () => Promise<boolean>;
  settleResetConfirmation: (confirmed: boolean) => void;
  updated: () => void;
  handleBoardCommand: (event: BoardCommandEvent) => void;
  handleBoardDockChange: (dock: "bottom" | "hidden" | "left" | "right") => void;
  handleBoardDockResize: (
    dock: "bottom" | "left" | "right",
    event: CustomEvent<{ splitRatio: number }>,
  ) => void;
  persistBoardSessionView: (patch: { face?: "chat" | "dashboard"; activeTabId?: string }) => void;
  resolveBoardProvider: () => BoardProvider;
  resolveBoardView: () => { activeTabId: string; dock: string; face: string };
};

type MockProvider = BoardProvider & { emitCommand(command: BoardCommandEvent["command"]): void };

function mockBoardProvider(sessionKey: string): MockProvider {
  return boardProviderForSession(sessionKey) as MockProvider;
}

function nullBoardProvider(sessionKey: string): BoardProvider {
  window.history.replaceState({}, "", "/");
  return boardProviderForSession(sessionKey);
}

function createTestPane(sessions: SessionCapability = {} as SessionCapability) {
  const pane = document.createElement("openclaw-chat-pane") as unknown as TestChatPane;
  const client = {} as GatewayBrowserClient;
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  pane.context = {
    sessions,
    gateway: { snapshot: { client, connected: true } },
  } as unknown as ApplicationContext;
  pane.state = {
    chatError: null,
    chatLoading: false,
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
    sessions,
    sessionsError: null,
    sessionsLoading: false,
  } as unknown as ChatPageHost;
  pane.connectedClient = client;
  pane.connectionGeneration = 1;
  return pane;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  window.history.replaceState({}, "", "/?mockBoard=1");
});

afterEach(() => {
  window.history.replaceState({}, "", "/");
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("chat pane board shell", () => {
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
      gateway: { snapshot: { client, connected: true } },
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

  it("keeps chat-only reset confirmation disabled", async () => {
    const pane = createTestPane();
    pane.boardProvider = nullBoardProvider("agent:main:current");

    await expect(pane.confirmConversationReset()).resolves.toBe(true);
    expect(pane.resetConfirmationOpen).toBe(false);
  });

  it("reacts to transient set_chat_dock provider events", () => {
    const pane = createTestPane();
    const provider = mockBoardProvider("agent:main:current");
    pane.boardProvider = provider;
    const unsubscribe = provider.events.subscribe((event) => pane.handleBoardCommand(event));

    provider.emitCommand({ kind: "set_chat_dock", dock: "left" });

    expect(pane.resolveBoardView()).toMatchObject({ activeTabId: "main", dock: "left" });
    unsubscribe();
  });

  it("restores the visible dock edge after hidden state reloads", () => {
    const provider = mockBoardProvider("agent:main:current");
    const pane = createTestPane();
    pane.boardProvider = provider;

    pane.handleBoardDockChange("left");
    pane.handleBoardDockChange("hidden");

    const reloadedPane = createTestPane();
    reloadedPane.boardProvider = provider;
    expect(reloadedPane.resolveBoardView()).toMatchObject({
      dock: "hidden",
      reopenDock: "left",
    });
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
    pane.persistBoardSessionView({ face: "dashboard", activeTabId: "research" });

    pane.boardProvider = mockBoardProvider("agent:main:main");

    expect(pane.resolveBoardView()).toMatchObject({
      activeTabId: "research",
      face: "dashboard",
    });
  });

  it("uses in-memory board preferences before persisted settings", () => {
    const pane = createTestPane();
    pane.boardProvider = mockBoardProvider("agent:main:current");
    pane.state.settings = {
      ...loadSettings(),
      boardSessionViews: {
        "agent:main:current": { face: "dashboard", activeTabId: "research" },
      },
    };
    localStorage.clear();

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
        "agent:main:first": { face: "chat", activeTabId: "main" },
      },
    });
    const firstPane = createTestPane();
    firstPane.state.sessionKey = "agent:main:first";
    firstPane.state.settings = initialSettings;
    firstPane.boardProvider = mockBoardProvider("agent:main:first");
    const secondPane = createTestPane();
    secondPane.state.sessionKey = "agent:main:second";
    secondPane.state.settings = initialSettings;
    secondPane.boardProvider = mockBoardProvider("agent:main:second");

    firstPane.persistBoardSessionView({ face: "dashboard", activeTabId: "research" });

    secondPane.state.sessionKey = "agent:main:first";
    secondPane.boardProvider = mockBoardProvider("agent:main:first");
    expect(secondPane.resolveBoardView()).toMatchObject({
      face: "dashboard",
      activeTabId: "research",
    });

    secondPane.state.sessionKey = "agent:main:second";
    secondPane.boardProvider = mockBoardProvider("agent:main:second");
    secondPane.persistBoardSessionView({ face: "dashboard", activeTabId: "main" });

    expect(loadSettings().boardSessionViews).toMatchObject({
      "agent:main:first": { face: "dashboard", activeTabId: "research" },
      "agent:main:second": { face: "dashboard", activeTabId: "main" },
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

  it("enables MCP App pinning only when app-view and put methods are both advertised", () => {
    window.history.replaceState({}, "", "/");
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
      const pane = createTestPane();
      const sessionKey = `agent:main:${testCase.suffix}`;
      const client = {
        request: vi.fn(async () => ({ sessionKey, revision: 0, tabs: [], widgets: [] })),
        addEventListener: vi.fn(() => () => {}),
      } as unknown as GatewayBrowserClient;
      pane.state.sessionKey = sessionKey;
      pane.context = {
        ...pane.context,
        gateway: {
          ...pane.context.gateway,
          snapshot: {
            client,
            connected: true,
            hello: { features: { methods: testCase.methods } },
          } as never,
        },
      };

      expect(pane.resolveBoardProvider().canPinMcpApps).toBe(testCase.expected);
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
    window.history.replaceState({}, "", "/");
    const pane = createTestPane();
    const sessionKey = `agent:main:scope-${profile.profile.replaceAll(" ", "-")}`;
    const client = {
      request: vi.fn(async () => ({ sessionKey, revision: 0, tabs: [], widgets: [] })),
      addEventListener: vi.fn(() => () => {}),
    } as unknown as GatewayBrowserClient;
    pane.state.sessionKey = sessionKey;
    pane.context = {
      ...pane.context,
      gateway: {
        ...pane.context.gateway,
        snapshot: {
          client,
          connected: true,
          hello: {
            auth: { role: "operator", scopes: profile.scopes },
            features: {
              methods: ["board.get", "board.widget.appView", "board.widget.put"],
              capabilities: ["board-widget-put-canvas-doc"],
            },
          },
        } as never,
      },
    };

    const provider = pane.resolveBoardProvider();
    expect(provider.canMutate).toBe(profile.canMutate);
    expect(provider.canGrant).toBe(profile.canGrant);
    expect(provider.canPinWidgets).toBe(profile.canMutate);
    expect(provider.canPinMcpApps).toBe(profile.canMutate);
  });

  it("uses the side dock width for rail and detail breakpoints", () => {
    expect(
      resolveBoardChatLayoutWidth({
        paneWidth: 1400,
        hasBoard: true,
        face: "dashboard",
        dock: "right",
        dockWidth: 420,
      }),
    ).toBe(420);
    expect(
      resolveBoardChatLayoutWidth({
        paneWidth: 1400,
        hasBoard: true,
        face: "dashboard",
        dock: "bottom",
        dockWidth: 420,
      }),
    ).toBe(1400);
  });

  it("persists dashboard chat dock resizing across pane recreation", () => {
    const pane = createTestPane();
    const previous = document.createElement("div");
    const divider = document.createElement("div");
    const next = document.createElement("div");
    previous.getBoundingClientRect = () => ({ width: 650 }) as DOMRect;
    next.getBoundingClientRect = () => ({ width: 350 }) as DOMRect;
    const container = document.createElement("div");
    container.append(previous, divider, next);
    divider.addEventListener("resize", (event) => {
      pane.handleBoardDockResize("right", event as unknown as CustomEvent<{ splitRatio: number }>);
    });
    divider.dispatchEvent(new CustomEvent("resize", { detail: { splitRatio: 0.65 } }));

    const recreated = createTestPane();
    expect(recreated.boardChatDockSize.width).toBe(350);
  });
});
