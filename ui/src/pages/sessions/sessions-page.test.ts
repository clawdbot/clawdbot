/* @vitest-environment jsdom */

import { nothing } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionCompactionCheckpoint,
  SessionsListResult,
} from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { getWorkboardState } from "../../lib/workboard/index.ts";
import {
  createContext,
  createGateway,
  createRenderedPage,
  createSessions,
  type TestSessionsPage,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

type TestSessionMenu = HTMLElement & {
  forkDisabled: boolean;
  workboard: { captured: boolean; busy: boolean } | null;
  readonly updateComplete: Promise<boolean>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function createPage(context: ApplicationContext): Promise<TestSessionsPage> {
  const page = document.createElement("openclaw-sessions-page") as TestSessionsPage;
  page.context = context;
  page.render = () => nothing;
  document.body.append(page);
  await page.updateComplete;
  return page;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(showConfirmDialog).mockReset();
  vi.restoreAllMocks();
});

describe("sessions page lifecycle", () => {
  it("switches between Active and Archived with the route parameter", async () => {
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const context = createContext(gateway, createSessions());
    const page = await createRenderedPage(context, {
      ts: Date.now(),
      path: "",
      count: 0,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [],
    });

    const docsLink = page.querySelector<HTMLAnchorElement>(".page-subtitle a");
    expect(docsLink?.textContent?.trim()).toBe("Learn more");
    expect(docsLink?.href).toBe("https://docs.openclaw.ai/concepts/session");

    const archived = [
      ...page.querySelectorAll<HTMLElement & { checked: boolean }>(
        ".sessions-view-segment wa-radio",
      ),
    ].find((radio) => radio.textContent?.trim() === "Archived");
    const group = archived?.closest<HTMLElement & { value: string }>("wa-radio-group");
    if (group) {
      group.value = "archived";
      group.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await page.updateComplete;

    expect(page.statusFilter).toBe("archived");
    expect(context.navigate).toHaveBeenCalledWith("sessions", { search: "?status=archived" });
    expect(
      [...page.querySelectorAll<HTMLElement & { checked: boolean }>("wa-radio")].find(
        (radio) => radio.textContent?.trim() === "Archived",
      )?.checked,
    ).toBe(true);
  });

  it("offers undo after archiving from the Sessions page", async () => {
    const key = "agent:main:pinned";
    const patch = vi.fn(async () => ({
      ok: true as const,
      path: "",
      key,
      entry: { sessionId: key },
    }));
    const sessions = createSessions({ patch });
    const mutableGateway = createGateway({} as GatewayBrowserClient);
    mutableGateway.emit({ sessionKey: key });
    const page = await createPage(createContext(mutableGateway.gateway, sessions));
    const toast = document.createElement("openclaw-toast-host");
    document.body.append(toast);
    await toast.updateComplete;

    await page.archiveSessionWithUndo({
      key,
      sessionId: "session-pinned",
      pinned: true,
    } as GatewaySessionRow);
    await toast.updateComplete;
    toast.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(mutableGateway.setSessionKey).not.toHaveBeenCalled();

    expect(patch).toHaveBeenNthCalledWith(
      1,
      key,
      { archived: true },
      { agentId: undefined, expectedSessionId: "session-pinned" },
    );
    expect(patch).toHaveBeenNthCalledWith(
      2,
      key,
      { archived: false, pinned: true },
      { agentId: undefined, expectedSessionId: "session-pinned" },
    );
  });

  it("keeps the archive Undo working after navigating off the Sessions page", async () => {
    const key = "agent:main:navigated";
    const patch = vi.fn(async () => ({
      ok: true as const,
      path: "",
      key,
      entry: { sessionId: key },
    }));
    const sessions = createSessions({ patch });
    const mutableGateway = createGateway({} as GatewayBrowserClient);
    mutableGateway.emit({ sessionKey: key });
    const page = await createPage(createContext(mutableGateway.gateway, sessions));
    const toast = document.createElement("openclaw-toast-host");
    document.body.append(toast);
    await toast.updateComplete;

    await page.archiveSessionWithUndo({
      key,
      sessionId: "session-nav",
      pinned: false,
    } as GatewaySessionRow);
    await toast.updateComplete;
    // The toast host outlives the page; navigation unmounts the page element.
    page.remove();
    toast.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch).toHaveBeenNthCalledWith(
      2,
      key,
      { archived: false },
      { agentId: undefined, expectedSessionId: "session-nav" },
    );
  });

  it("submits one trimmed bounded transcript search and adopts its status", async () => {
    const response = deferred<SessionsSearchResult>();
    const request = vi.fn(() => response.promise);
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const page = await createPage(createContext(mutableGateway.gateway, createSessions()));
    page.result = {
      count: 1,
      sessions: [{ key: "agent:main:launch" }],
    } as SessionsListResult;

    page.updateTranscriptSearchQuery("  launch code  ");
    const pending = page.runTranscriptSearch();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith("sessions.search", {
      agentId: "main",
      sessionKeys: ["agent:main:launch"],
      query: "launch code",
      limit: 25,
    });
    expect(page.transcriptSearch).toEqual({ status: "loading" });

    const result: SessionsSearchResult = {
      results: [
        {
          sessionKey: "agent:main:launch",
          sessionId: "launch",
          messageId: "message-1",
          role: "user",
          timestamp: 42,
          snippet: "launch code",
          score: 1,
        },
      ],
      indexing: true,
      truncated: true,
    };
    response.resolve(result);
    await pending;

    expect(page.transcriptSearchQuery).toBe("launch code");
    expect(page.transcriptSearch).toEqual({
      status: "results",
      results: result.results,
      indexing: true,
      truncated: true,
    });
  });

  it("fans all-agent transcript search out by owning agent and merges ranked results", async () => {
    const request = vi.fn(async (_method: string, params: { agentId: string }) => ({
      results: [
        {
          sessionKey: `agent:${params.agentId}:one`,
          sessionId: `${params.agentId}-one`,
          messageId: `${params.agentId}-message`,
          role: "assistant" as const,
          timestamp: params.agentId === "writer" ? 2 : 1,
          snippet: params.agentId,
          score: params.agentId === "writer" ? 2 : 1,
        },
      ],
    }));
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const context = createContext(mutableGateway.gateway, createSessions());
    context.agentSelection.state.scopeId = null;
    const page = await createPage(context);
    page.result = {
      count: 2,
      sessions: [{ key: "agent:main:one" }, { key: "agent:writer:one" }],
    } as SessionsListResult;

    page.updateTranscriptSearchQuery("needle");
    await page.runTranscriptSearch();

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({ agentId: "main", sessionKeys: ["agent:main:one"] }),
    );
    expect(request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({ agentId: "writer", sessionKeys: ["agent:writer:one"] }),
    );
    expect(page.transcriptSearch.status).toBe("results");
    if (page.transcriptSearch.status === "results") {
      expect(page.transcriptSearch.results.map((result) => result.sessionKey)).toEqual([
        "agent:writer:one",
        "agent:main:one",
      ]);
    }
  });

  it("does not request empty or unadvertised transcript searches", async () => {
    const request = vi.fn();
    const page = await createPage(
      createContext(
        createGateway({ request } as unknown as GatewayBrowserClient).gateway,
        createSessions(),
      ),
    );

    page.updateTranscriptSearchQuery("   ");
    await page.runTranscriptSearch();
    page.updateTranscriptSearchQuery("not advertised");
    await page.runTranscriptSearch();

    expect(request).not.toHaveBeenCalled();
    expect(page.transcriptSearch).toEqual({ status: "idle" });
  });

  it("reports a connection error instead of silently dropping a patch", async () => {
    const patch = vi.fn();
    const sessions = createSessions({ patch });
    const mutableGateway = createGateway({} as GatewayBrowserClient);
    const page = await createPage(createContext(mutableGateway.gateway, sessions));
    // Gateway drops while a rename dialog is open; submit lands afterwards.
    mutableGateway.emit({ phase: "reconnecting", client: null });

    const result = await page.patchSession("agent:main:main", { label: "renamed" });

    expect(result).toBe("failed");
    expect(patch).not.toHaveBeenCalled();
    expect(page.error).toBe("Connect to the Gateway to change sessions.");
  });

  it("shows a connection error in the checkpoints drawer while disconnected", async () => {
    const mutableGateway = createGateway({} as GatewayBrowserClient);
    const page = await createPage(createContext(mutableGateway.gateway, createSessions()));
    mutableGateway.emit({ phase: "reconnecting", client: null });

    await page.loadCheckpoint("agent:main:main");

    // Without the recorded error the drawer would render "No checkpoints"
    // beside a nonzero checkpoint badge.
    expect(page.checkpointErrorByKey["agent:main:main"]).toBe(
      "Connect to the Gateway to change sessions.",
    );
  });

  it("drops a transcript result after the query changes while it is pending", async () => {
    const response = deferred<SessionsSearchResult>();
    const request = vi.fn(() => response.promise);
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const page = await createPage(createContext(mutableGateway.gateway, createSessions()));
    page.result = {
      count: 1,
      sessions: [{ key: "agent:main:stale" }],
    } as SessionsListResult;

    page.updateTranscriptSearchQuery("old query");
    const pending = page.runTranscriptSearch();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    page.updateTranscriptSearchQuery("new query");
    response.resolve({
      results: [
        {
          sessionKey: "agent:main:stale",
          sessionId: "stale",
          messageId: "message-stale",
          role: "assistant",
          timestamp: 42,
          snippet: "old query",
          score: 1,
        },
      ],
    });
    await pending;

    expect(page.transcriptSearchQuery).toBe("new query");
    expect(page.transcriptSearch).toEqual({ status: "idle" });
  });

  it("drops transcript results and in-flight work when agent scope changes", async () => {
    const response = deferred<SessionsSearchResult>();
    const request = vi.fn(() => response.promise);
    const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
    mutableGateway.emit({
      hello: { features: { methods: ["sessions.search"] } } as ApplicationGatewaySnapshot["hello"],
    });
    const context = createContext(mutableGateway.gateway, createSessions());
    let notifyScopeChange: Parameters<ApplicationContext["agentSelection"]["subscribe"]>[0] = () =>
      undefined;
    context.agentSelection.subscribe = (listener) => {
      notifyScopeChange = listener;
      return () => undefined;
    };
    const page = await createPage(context);
    page.result = {
      count: 1,
      sessions: [{ key: "agent:main:stale" }],
    } as SessionsListResult;

    page.updateTranscriptSearchQuery("needle");
    const pending = page.runTranscriptSearch();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    context.agentSelection.state.scopeId = null;
    notifyScopeChange(context.agentSelection.state);

    expect(page.transcriptSearchQuery).toBe("needle");
    expect(page.transcriptSearch).toEqual({ status: "idle" });

    response.resolve({
      results: [
        {
          sessionKey: "agent:main:stale",
          sessionId: "stale",
          messageId: "message-stale",
          role: "assistant",
          timestamp: 42,
          snippet: "needle",
          score: 1,
        },
      ],
    });
    await pending;
    expect(page.transcriptSearch).toEqual({ status: "idle" });
  });

  it("disables Fork session for model-selection-locked rows", async () => {
    const row = {
      key: "agent:main:locked",
      kind: "direct",
      modelSelectionLocked: true,
    } as GatewaySessionRow;
    const result = { count: 1, sessions: [row] } as SessionsListResult;
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const page = await createRenderedPage(createContext(gateway, createSessions()), result);

    page.openSessionMenu(row, { x: 10, y: 20 }, document.createElement("button"));
    await page.updateComplete;

    const menu = page.querySelector<TestSessionMenu>("openclaw-session-menu");
    if (!menu) {
      throw new Error("Expected sessions page menu");
    }
    await menu.updateComplete;
    expect(menu.forkDisabled).toBe(true);
    expect(menu.querySelector<HTMLButtonElement>('[data-shortcut="f"]')?.disabled).toBe(true);
  });

  it("enables Archive but keeps Delete disabled for an active non-main row", async () => {
    const row = {
      key: "agent:main:running",
      sessionId: "session-running",
      kind: "direct",
      hasActiveRun: true,
    } as GatewaySessionRow;
    const result = { count: 1, sessions: [row] } as SessionsListResult;
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const page = await createRenderedPage(createContext(gateway, createSessions()), result);

    page.openSessionMenu(row, { x: 10, y: 20 }, document.createElement("button"));
    await page.updateComplete;

    const menu = page.querySelector<TestSessionMenu>("openclaw-session-menu");
    if (!menu) {
      throw new Error("Expected sessions page menu");
    }
    await menu.updateComplete;
    expect(menu.querySelector<HTMLButtonElement>('[value="toggle-archived"]')?.disabled).toBe(
      false,
    );
    expect(menu.querySelector<HTMLButtonElement>('[value="delete"]')?.disabled).toBe(true);
  });

  it.each([
    {
      name: "offers capture when only an archived Workboard card matches",
      metadata: { archivedAt: 10 },
      captured: false,
    },
    {
      name: "recognizes an active Workboard card",
      metadata: undefined,
      captured: true,
    },
  ])("$name", async ({ metadata, captured }) => {
    const row = { key: "agent:main:captured", kind: "direct" } as GatewaySessionRow;
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const context = createContext(gateway, createSessions());
    context.runtimeConfig.state.configSnapshot = {
      config: { plugins: { entries: { workboard: { enabled: true } } } },
    };
    context.workboard.state.cards = [
      {
        id: "captured-card",
        title: "Captured session",
        status: "todo",
        priority: "normal",
        labels: [],
        position: 1000,
        createdAt: 1,
        updatedAt: 2,
        sessionKey: row.key,
        metadata,
      },
    ];
    const result = { count: 1, sessions: [row] } as SessionsListResult;
    const page = await createRenderedPage(context, result);

    page.openSessionMenu(row, { x: 10, y: 20 }, document.createElement("button"));
    await page.updateComplete;

    const menu = page.querySelector<TestSessionMenu>("openclaw-session-menu");
    if (!menu) {
      throw new Error("Expected sessions page menu");
    }
    await menu.updateComplete;

    expect(menu.workboard).toEqual({ captured, busy: false });
    expect(menu.querySelector('[value="workboard"]')?.textContent).toContain(
      captured ? "Open Workboard card" : "Add to Workboard",
    );
  });

  it("disables the Workboard action for every concurrently captured session", async () => {
    const row = { key: "agent:main:second-capture", kind: "direct" } as GatewaySessionRow;
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const context = createContext(gateway, createSessions());
    context.runtimeConfig.state.configSnapshot = {
      config: { plugins: { entries: { workboard: { enabled: true } } } },
    };
    context.workboard.state.capturingSessionKeys.add("agent:main:first-capture");
    context.workboard.state.capturingSessionKeys.add(row.key);
    const result = { count: 1, sessions: [row] } as SessionsListResult;
    const page = await createRenderedPage(context, result);

    page.openSessionMenu(row, { x: 10, y: 20 }, document.createElement("button"));
    await page.updateComplete;

    const menu = page.querySelector<TestSessionMenu>("openclaw-session-menu");
    if (!menu) {
      throw new Error("Expected sessions page menu");
    }
    await menu.updateComplete;

    expect(menu.workboard).toEqual({ captured: false, busy: true });
    expect(menu.querySelector('[value="workboard"]')?.hasAttribute("disabled")).toBe(true);
  });

  it("rejects preloaded data after a same-client reconnect and loads the current epoch", async () => {
    const client = {} as GatewayBrowserClient;
    const mutableGateway = createGateway(client);
    const preloadedSnapshot = mutableGateway.gateway.snapshot;
    mutableGateway.emit({ phase: "reconnecting", client });
    mutableGateway.emit({ phase: "connected", client });
    const freshResult = { count: 1, sessions: [{ key: "fresh" }] } as SessionsListResult;
    const sessions = createSessions({ list: vi.fn(async () => freshResult) });
    const context = createContext(mutableGateway.gateway, sessions);
    const page = document.createElement("openclaw-sessions-page") as TestSessionsPage;
    page.context = context;
    page.render = () => nothing;
    page.routeData = {
      gateway: mutableGateway.gateway,
      gatewaySnapshot: preloadedSnapshot,
      result: { count: 1, sessions: [{ key: "stale" }] } as SessionsListResult,
      error: null,
      expandedSessionKey: null,
      statusFilter: "active",
    };

    document.body.append(page);
    await page.updateComplete;
    await vi.waitFor(() => expect(page.result?.sessions[0]?.key).toBe("fresh"));

    expect(sessions.list).toHaveBeenCalledOnce();
    expect(page.result?.sessions.map((session) => session.key)).toEqual(["fresh"]);
  });

  it("rejects session and checkpoint results after the sessions capability changes", async () => {
    const list = deferred<SessionsListResult | null>();
    const checkpoints = deferred<SessionCompactionCheckpoint[]>();
    const sessions = createSessions({
      list: vi.fn(() => list.promise),
      listCheckpoints: vi.fn(() => checkpoints.promise),
    });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const context = createContext(gateway, sessions);
    const page = await createPage(context);

    const listRequest = page.loadSessions();
    const checkpointRequest = page.loadCheckpoint("main");
    await vi.waitFor(() => {
      expect(sessions.list).toHaveBeenCalledOnce();
      expect(sessions.listCheckpoints).toHaveBeenCalledOnce();
    });

    page.context = { ...context, sessions: createSessions() };
    page.requestUpdate();
    await page.updateComplete;
    list.resolve({ count: 1, sessions: [{ key: "stale" }] } as SessionsListResult);
    checkpoints.resolve([{ checkpointId: "stale" }] as SessionCompactionCheckpoint[]);
    await Promise.all([listRequest, checkpointRequest]);

    expect(page.result).toBeNull();
    expect(page.loading).toBe(false);
    expect(page.checkpointItemsByKey).toEqual({});
    expect(page.checkpointLoadingKey).toBeNull();
  });

  it("scopes list requests while preserving an all-agents escape", async () => {
    const sessions = createSessions();
    const context = createContext(createGateway({} as GatewayBrowserClient).gateway, sessions);
    const page = await createPage(context);

    await page.loadSessions();
    expect(sessions.list).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "main" }));

    context.agentSelection.state.scopeId = null;
    await page.loadSessions();
    expect(sessions.list).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ agentId: expect.anything() }),
    );
  });

  it("invalidates checkpoint work and mutation locks on same-client disconnect", async () => {
    const checkpoints = deferred<SessionCompactionCheckpoint[]>();
    const sessions = createSessions({
      listCheckpoints: vi.fn(() => checkpoints.promise),
    });
    const client = {} as GatewayBrowserClient;
    const mutableGateway = createGateway(client);
    const page = await createPage(createContext(mutableGateway.gateway, sessions));
    const request = page.loadCheckpoint("main");
    page.checkpointBusyKey = "busy";
    page.sessionMutationPending = true;

    mutableGateway.emit({ phase: "reconnecting", client });

    expect(page.checkpointLoadingKey).toBeNull();
    expect(page.checkpointBusyKey).toBeNull();
    expect(page.sessionMutationPending).toBe(false);
    checkpoints.resolve([{ checkpointId: "stale" }] as SessionCompactionCheckpoint[]);
    await request;
    expect(page.checkpointItemsByKey).toEqual({});
  });

  it("closes an open row menu on a same-client disconnect", async () => {
    const sessions = createSessions();
    const client = {} as GatewayBrowserClient;
    const mutableGateway = createGateway(client);
    const page = await createPage(createContext(mutableGateway.gateway, sessions));
    const trigger = document.createElement("button");
    page.openSessionMenu(
      { key: "agent:main:work" } as GatewaySessionRow,
      { x: 10, y: 20 },
      trigger,
    );

    mutableGateway.emit({ phase: "reconnecting", client });

    expect(page.sessionMenu).toBeNull();
    expect(page.sessionMenuTrigger).toBeNull();
  });

  it("retargets the Gateway after deleting the current session", async () => {
    const key = "agent:writer:work";
    const sessions = createSessions({
      deleteMany: vi.fn(async () => ({ deleted: [key], errors: [], preservedWorktrees: [] })),
    });
    const mutableGateway = createGateway({} as GatewayBrowserClient);
    mutableGateway.emit({ sessionKey: key });
    const page = await createPage(createContext(mutableGateway.gateway, sessions));
    page.result = { count: 1, sessions: [{ key }] } as SessionsListResult;
    page.selectedKeys = new Set([key]);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await page.deleteSelected();

    expect(sessions.deleteMany).toHaveBeenCalledWith([{ key, agentId: undefined }]);
    expect(mutableGateway.setSessionKey).toHaveBeenCalledWith("agent:writer:main");
    expect(page.result?.sessions).toEqual([]);
    expect(page.selectedKeys).toEqual(new Set());
  });

  it("does not delete a selection after the gateway changes during confirmation", async () => {
    const confirmation = deferred<boolean>();
    vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
    const sessions = createSessions({ deleteMany: vi.fn() });
    const mutableGateway = createGateway({} as GatewayBrowserClient);
    const page = await createPage(createContext(mutableGateway.gateway, sessions));
    page.result = {
      count: 1,
      sessions: [{ key: "agent:main:old" }],
    } as SessionsListResult;
    page.selectedKeys = new Set(["agent:main:old"]);

    const deleting = page.deleteSelected();
    await Promise.resolve();
    mutableGateway.emit({ phase: "reconnecting", client: null });
    confirmation.resolve(true);
    await deleting;

    expect(sessions.deleteMany).not.toHaveBeenCalled();
  });

  it("archive-gates a confirmed archived row-menu deletion", async () => {
    const key = "agent:main:work";
    const sessions = createSessions({
      deleteMany: vi.fn(async () => ({ deleted: [key], errors: [], preservedWorktrees: [] })),
    });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const page = await createPage(createContext(gateway, sessions));
    const row = { key, label: "Work", archived: true } as GatewaySessionRow;
    page.result = { count: 1, sessions: [row] } as SessionsListResult;
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await page.deleteSessionFromMenu(row);

    expect(showConfirmDialog).toHaveBeenCalledOnce();
    expect(sessions.deleteMany).toHaveBeenCalledWith([
      { key, agentId: undefined, archivedOnly: true },
    ]);
    expect(page.result?.sessions).toEqual([]);
  });

  it.each([
    ["active", false],
    ["unknown", undefined],
  ] as const)("keeps %s row-menu deletion admin-only", async (_state, archived) => {
    const key = `agent:main:${_state}`;
    const sessions = createSessions({
      deleteMany: vi.fn(async () => ({ deleted: [], errors: [], preservedWorktrees: [] })),
    });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const page = await createPage(createContext(gateway, sessions));
    const row = {
      key,
      label: _state,
      ...(archived === undefined ? {} : { archived }),
    } as GatewaySessionRow;
    page.result = { count: 1, sessions: [row] } as SessionsListResult;
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await page.deleteSessionFromMenu(row);

    expect(sessions.deleteMany).toHaveBeenCalledWith([{ key, agentId: undefined }]);
  });

  it("derives archive gates per selected row and keeps unknown rows admin-only", async () => {
    const activeKey = "agent:main:active";
    const archivedKey = "agent:main:archived";
    const unknownKey = "agent:main:unknown";
    const sessions = createSessions({
      deleteMany: vi.fn(async () => ({
        deleted: [archivedKey],
        errors: ["active denied", "unknown denied"],
        preservedWorktrees: [],
      })),
    });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const page = await createPage(createContext(gateway, sessions));
    page.result = {
      count: 2,
      sessions: [
        { key: activeKey, archived: false },
        { key: archivedKey, archived: true },
      ],
    } as SessionsListResult;
    page.selectedKeys = new Set([activeKey, archivedKey, unknownKey]);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await page.deleteSelected();

    expect(sessions.deleteMany).toHaveBeenCalledWith([
      { key: activeKey, agentId: undefined },
      { key: archivedKey, agentId: undefined, archivedOnly: true },
      { key: unknownKey, agentId: undefined },
    ]);
    expect(page.result).toMatchObject({
      count: 1,
      sessions: [{ key: activeKey, archived: false }],
    });
    expect(page.selectedKeys).toEqual(new Set([activeKey, unknownKey]));
    expect(page.error).toBe("active denied; unknown denied");
  });

  it("stops an active cloud worker and refreshes the session roster", async () => {
    const request = vi.fn(() => Promise.resolve({ ok: true }));
    const list = vi.fn(async () => ({ count: 0, sessions: [] }) as unknown as SessionsListResult);
    const sessions = createSessions({ list });
    const { gateway } = createGateway({ request } as unknown as GatewayBrowserClient);
    const page = await createPage(createContext(gateway, sessions));
    const row = {
      key: "agent:main:cloud",
      label: "Cloud task",
      placement: {
        state: "active",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
        environmentId: "environment-1",
        activeOwnerEpoch: 1,
        workerBundleHash: "0".repeat(64),
        workspaceBaseManifestRef: "base-ref",
        remoteWorkspaceDir: "/workspace",
      },
    } as GatewaySessionRow;
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await page.stopCloudWorker(row);

    expect(showConfirmDialog).toHaveBeenCalledWith({
      message: 'Stop the cloud worker for "Cloud task"?',
      confirmLabel: "Stop worker",
      danger: true,
    });
    expect(request).toHaveBeenCalledWith(
      "sessions.reclaim",
      { key: "agent:main:cloud", agentId: "main" },
      { timeoutMs: 10 * 60_000 },
    );
    expect(list).toHaveBeenCalledOnce();
    expect(page.sessionMutationPending).toBe(false);
  });

  it("destroys a pending cloud worker and reports its terminal state", async () => {
    const request = vi.fn(() =>
      Promise.resolve({ status: "unavailable", worker: { state: "destroyed" } }),
    );
    const list = vi.fn(async () => ({ count: 0, sessions: [] }) as unknown as SessionsListResult);
    const sessions = createSessions({ list });
    const { gateway } = createGateway({ request } as unknown as GatewayBrowserClient);
    const page = await createPage(createContext(gateway, sessions));
    const toast = document.createElement("openclaw-toast-host");
    document.body.append(toast);
    await toast.updateComplete;
    const row = {
      key: "agent:main:cloud",
      label: "Cloud task",
      placement: {
        state: "provisioning",
        generation: 1,
        createdAtMs: 1,
        updatedAtMs: 1,
        stateChangedAtMs: 1,
        environmentId: "environment-1",
      },
      hasActiveRun: true,
    } as GatewaySessionRow;
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await page.stopCloudWorker(row);

    expect(showConfirmDialog).toHaveBeenCalledWith({
      message: 'Stop the cloud worker for "Cloud task"?',
      confirmLabel: "Stop worker",
      danger: true,
    });
    expect(request).toHaveBeenCalledWith("environments.destroy", {
      environmentId: "environment-1",
    });
    expect(list).toHaveBeenCalledOnce();
    expect(toast.querySelector(".app-toast__message")?.textContent).toBe(
      'Cloud worker for "Cloud task" is destroyed.',
    );
    expect(page.sessionMutationPending).toBe(false);
  });

  it("surfaces a rejected custom-group creation on the Sessions page", async () => {
    const groupsPut = vi.fn(async () => {
      throw new Error("group name exceeds 512 characters");
    });
    const sessions = createSessions({ groupsPut });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const page = await createPage(createContext(gateway, sessions));
    const name = "X".repeat(513);

    await page.rememberCustomGroup(name);

    expect(groupsPut).toHaveBeenCalledWith([name]);
    expect(page.error).toBe("Error: group name exceeds 512 characters");
  });

  it("drops stale mutation state, errors, and navigation after disconnect", async () => {
    const deleted = deferred<{
      deleted: string[];
      errors: string[];
      preservedWorktrees: Array<{ id: string; branch: string; path: string }>;
    }>();
    const patched = deferred<unknown>();
    const forked = deferred<string | null>();
    const branched = deferred<{ key: string }>();
    const restored = deferred<unknown>();
    const captured = deferred<unknown>();
    const groupsPut = deferred<Awaited<ReturnType<SessionCapability["groupsPut"]>>>();
    const sessions = createSessions({
      deleteMany: vi.fn(() => deleted.promise),
      patch: vi.fn(() => patched.promise as never),
      create: vi.fn(() => forked.promise),
      branchCheckpoint: vi.fn(() => branched.promise as never),
      restoreCheckpoint: vi.fn(() => restored.promise as never),
      groupsPut: vi.fn(() => groupsPut.promise),
    });
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return Promise.resolve({ messages: [] });
      }
      if (method === "workboard.cards.create") {
        return captured.promise;
      }
      return Promise.resolve({});
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const mutableGateway = createGateway(client);
    const context = createContext(mutableGateway.gateway, sessions);
    getWorkboardState(context.workboard).loaded = true;
    const page = await createPage(context);
    page.result = {
      count: 1,
      sessions: [{ key: "main", sessionId: "session-main" }],
    } as SessionsListResult;
    page.selectedKeys = new Set(["main"]);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    const requests = [
      page.deleteSelected(),
      page.patchSession("main", { archived: true }, undefined, "session-main"),
      page.forkSession("main"),
      page.branchCheckpoint("main", "branch-checkpoint"),
      page.restoreCheckpoint("main", "restore-checkpoint"),
      page.addToWorkboard({ key: "main" } as GatewaySessionRow),
      page.rememberCustomGroup("Stale group"),
    ];
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("workboard.cards.create", expect.any(Object)),
    );

    mutableGateway.emit({ phase: "reconnecting", client });
    deleted.resolve({ deleted: ["main"], errors: ["stale delete error"], preservedWorktrees: [] });
    patched.resolve({ ok: true });
    forked.resolve("forked");
    branched.resolve({ key: "branched" });
    restored.reject(new Error("stale restore error"));
    captured.reject(new Error("stale capture error"));
    groupsPut.reject(new Error("stale group error"));
    await Promise.all(requests);

    expect(page.result?.sessions.map((row) => row.key)).toEqual(["main"]);
    expect(page.selectedKeys).toEqual(new Set(["main"]));
    expect(page.error).toBeNull();
    expect(page.sessionMutationPending).toBe(false);
    expect(page.checkpointBusyKey).toBeNull();
    expect(mutableGateway.setSessionKey).not.toHaveBeenCalled();
    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("does not navigate when a mutation completes after the page detaches", async () => {
    const forked = deferred<string | null>();
    const sessions = createSessions({ create: vi.fn(() => forked.promise) });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const context = createContext(gateway, sessions);
    const page = await createPage(context);

    const request = page.forkSession("main");
    page.remove();
    forked.resolve("detached-fork");
    await request;

    expect(context.navigate).not.toHaveBeenCalled();
  });

  it("forks an active session from its last completed message", async () => {
    const create = vi.fn(async () => "active-fork");
    const sessions = createSessions({ create });
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const context = createContext(gateway, sessions);
    const page = await createPage(context);

    await page.forkSession("main", true);

    expect(create).toHaveBeenCalledWith({
      parentSessionKey: "main",
      fork: true,
      forkFrom: "last-completed",
    });
  });
});
