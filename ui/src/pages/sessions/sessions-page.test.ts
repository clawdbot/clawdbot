/* @vitest-environment jsdom */

import { nothing } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  PreservedSessionWorktree,
  SessionsSearchResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  GatewaySessionRow,
  SessionCompactionCheckpoint,
  SessionsListResult,
} from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { createSessionCapability, type SessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import type {
  SessionDeleteOutcome,
  SessionDeleteTarget,
} from "../../lib/sessions/session-capability.ts";
import {
  createContext,
  createGateway,
  createManagedSessions,
  createRenderedPage,
  createSessions,
  type TestSessionsPage,
} from "./sessions-page.test-support.ts";

vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

type TestSessionMenu = HTMLElement & {
  forkDisabled: boolean;
  readonly updateComplete: Promise<boolean>;
};

async function createPage(context: ApplicationContext): Promise<TestSessionsPage> {
  const page = document.createElement("openclaw-sessions-page") as TestSessionsPage;
  page.context = context;
  page.render = () => nothing;
  document.body.append(page);
  await page.updateComplete;
  return page;
}

async function createDeletionPage(rows: GatewaySessionRow[], agentId = "main") {
  let serverRows = rows;
  const deleteRequest = vi.fn(
    async (target: SessionDeleteTarget): Promise<SessionDeleteOutcome> => {
      const deleted = serverRows.some((row) => row.key === target.key);
      serverRows = serverRows.filter((row) => row.key !== target.key);
      return { deleted };
    },
  );
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "sessions.list") {
      return sessionsResult(serverRows, 1);
    }
    if (method === "sessions.delete") {
      return deleteRequest(params as SessionDeleteTarget);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const mutableGateway = createGateway({ request } as unknown as GatewayBrowserClient);
  const sessions = createSessionCapability(mutableGateway.gateway);
  onTestFinished(() => sessions.dispose());
  const subscribeList = vi.spyOn(sessions, "subscribeList");
  vi.spyOn(sessions, "deleteMany");
  const context = createContext(mutableGateway.gateway, sessions);
  context.agentSelection.state.selectedId = agentId;
  context.agentSelection.state.scopeId = agentId;
  const page = await createRenderedPage(context, sessionsResult(rows, 1), "all");
  await vi.waitFor(() => expect(page.loading).toBe(false));
  const query = subscribeList.mock.calls[0]![0];
  return {
    page,
    sessions,
    mutableGateway,
    deleteRequest,
    query,
    setRows: (next: GatewaySessionRow[]) => {
      serverRows = next;
    },
  };
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
    const response = createDeferred<SessionsSearchResult>();
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
    vi.mocked(page.context.sessions.list).mockResolvedValue(page.result);

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
    vi.mocked(context.sessions.list).mockResolvedValue(page.result);

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

  it("marks the exact qualified session read without a redundant routing agent", async () => {
    const patch = vi.fn(async () => ({
      ok: true as const,
      path: "",
      key: "agent:main:main",
      entry: { sessionId: "session-main" },
    }));
    const sessions = createSessions({ patch });
    const page = await createPage(
      createContext(createGateway({} as GatewayBrowserClient).gateway, sessions),
    );

    await expect(page.patchSession("agent:main:main", { unread: false })).resolves.toBe(
      "completed",
    );

    expect(patch).toHaveBeenCalledWith(
      "agent:main:main",
      { unread: false },
      { agentId: undefined },
    );
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
    const response = createDeferred<SessionsSearchResult>();
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
    vi.mocked(page.context.sessions.list).mockResolvedValue(page.result);

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
    const response = createDeferred<SessionsSearchResult>();
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
    vi.mocked(context.sessions.list).mockResolvedValue(page.result);

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

  it.each([
    ["green", "Green"],
    [null, "Default"],
  ] as const)("patches color %s from the sessions page menu", async (color, label) => {
    const row = {
      key: "agent:main:color",
      sessionId: "color-session",
      kind: "direct",
      updatedAt: 1,
    } satisfies GatewaySessionRow;
    const result = { count: 1, sessions: [row] } as SessionsListResult;
    const { gateway } = createGateway({} as GatewayBrowserClient);
    const sessions = createSessions();
    const page = await createRenderedPage(createContext(gateway, sessions), result);
    page.openSessionMenu(row, { x: 10, y: 20 }, document.createElement("button"));
    await page.updateComplete;
    const menu = page.querySelector<TestSessionMenu>("openclaw-session-menu");
    await menu?.updateComplete;
    const item = menu?.querySelector<HTMLButtonElement>(
      `.session-menu__color-choice[aria-label="${label}"]`,
    );
    expect(item).not.toBeNull();
    item?.click();
    await vi.waitFor(() =>
      expect(sessions.patch).toHaveBeenCalledWith(row.key, { color }, { agentId: undefined }),
    );
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

  it("invalidates checkpoint work and mutation locks on same-client disconnect", async () => {
    const checkpoints = createDeferred<SessionCompactionCheckpoint[]>();
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
    const sessionId = "session-writer-work";
    const { page, sessions, mutableGateway } = await createDeletionPage(
      [{ key, sessionId, kind: "direct", updatedAt: 1 }],
      "writer",
    );
    mutableGateway.emit({ sessionKey: key });
    page.selectedKeys = new Set([key]);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await page.deleteSelected();

    expect(sessions.deleteMany).toHaveBeenCalledWith([
      { key, agentId: undefined, expectedSessionId: sessionId },
    ]);
    expect(mutableGateway.setSessionKey).toHaveBeenCalledWith("agent:writer:main");
    expect(page.result?.sessions).toEqual([]);
    expect(page.selectedKeys).toEqual(new Set());
  });

  it.each([
    {
      scenario: "the selected row is replaced by an archived generation",
      originalArchived: false,
      replacement: { sessionId: "replacement-session", archived: true },
    },
    {
      scenario: "the selected row disappears from the roster",
      originalArchived: false,
      replacement: null,
    },
    {
      scenario: "an archived selection is replaced by an active generation",
      originalArchived: true,
      replacement: { sessionId: "replacement-session", archived: false },
    },
  ])(
    "preserves confirmed deletion identity when $scenario",
    async ({ originalArchived, replacement }) => {
      const key = "agent:main:confirmed";
      const confirmation = createDeferred<boolean>();
      vi.mocked(showConfirmDialog).mockReturnValueOnce(confirmation.promise);
      const sessions = createSessions({
        deleteMany: vi.fn(async () => ({ deleted: [], errors: [], preservedWorktrees: [] })),
      });
      const page = await createPage(
        createContext(createGateway({} as GatewayBrowserClient).gateway, sessions),
      );
      page.result = {
        count: 1,
        sessions: [{ key, sessionId: "confirmed-session", archived: originalArchived }],
      } as SessionsListResult;
      page.selectedKeys = new Set([key]);

      const deleting = page.deleteSelected();
      expect(showConfirmDialog).toHaveBeenCalledOnce();
      page.result = {
        count: replacement ? 1 : 0,
        sessions: replacement ? [{ key, ...replacement }] : [],
      } as SessionsListResult;
      confirmation.resolve(true);
      await deleting;

      expect(sessions.deleteMany).toHaveBeenCalledWith([
        {
          key,
          agentId: undefined,
          expectedSessionId: "confirmed-session",
          ...(originalArchived ? { archivedOnly: true } : {}),
        },
      ]);
    },
  );

  it("publishes optimistic removal and unrelated roster updates while bulk deletion is pending", async () => {
    const row: GatewaySessionRow = {
      key: "agent:main:before",
      sessionId: "before-id",
      kind: "direct",
      updatedAt: 1,
    };
    const arrived: GatewaySessionRow = {
      key: "agent:main:arrived",
      sessionId: "arrived-id",
      kind: "direct",
      updatedAt: 2,
    };
    const { page, sessions, deleteRequest, query, setRows } = await createDeletionPage([row]);
    const deleted = createDeferred<SessionDeleteOutcome>();
    deleteRequest.mockReturnValueOnce(deleted.promise);
    page.selectedKeys = new Set([row.key]);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    const deleting = page.deleteSelected();
    await vi.waitFor(() => expect(deleteRequest).toHaveBeenCalledOnce());
    expect(page.sessionMutationPending).toBe(true);
    expect(page.result?.sessions).toEqual([]);
    setRows([row, arrived]);
    await sessions.refreshList({ ...query, force: true });
    expect(page.sessionMutationPending).toBe(true);
    expect(page.result?.sessions.map((session) => session.key)).toEqual([arrived.key]);

    setRows([arrived]);
    deleted.resolve({ deleted: true });
    await deleting;
    expect(page.result?.sessions).toEqual([arrived]);
    expect(page.selectedKeys).toEqual(new Set());
    expect(page.sessionMutationPending).toBe(false);
  });

  it("does not delete a selection after the gateway changes during confirmation", async () => {
    const confirmation = createDeferred<boolean>();
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
    const row: GatewaySessionRow = {
      key,
      sessionId: "archived-id",
      kind: "direct",
      updatedAt: 1,
      label: "Work",
      archived: true,
    };
    const { page, sessions } = await createDeletionPage([row]);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await page.deleteSessionFromMenu(row);

    expect(showConfirmDialog).toHaveBeenCalledOnce();
    expect(sessions.deleteMany).toHaveBeenCalledWith([
      { key, agentId: undefined, archivedOnly: true, expectedSessionId: row.sessionId },
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
    const retryError = `Session ${activeKey} changed before deletion. Retry.`;
    const active: GatewaySessionRow = {
      key: activeKey,
      sessionId: "active-id",
      kind: "direct",
      updatedAt: 1,
      archived: false,
    };
    const archived: GatewaySessionRow = {
      key: archivedKey,
      sessionId: "archived-id",
      kind: "direct",
      updatedAt: 1,
      archived: true,
    };
    const { page, sessions, deleteRequest } = await createDeletionPage([active, archived]);
    deleteRequest.mockRejectedValueOnce(new Error(retryError));
    page.selectedKeys = new Set([activeKey, archivedKey, unknownKey]);
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    await page.deleteSelected();

    expect(sessions.deleteMany).toHaveBeenCalledWith([
      { key: activeKey, agentId: undefined, expectedSessionId: active.sessionId },
      {
        key: archivedKey,
        agentId: undefined,
        archivedOnly: true,
        expectedSessionId: archived.sessionId,
      },
      { key: unknownKey, agentId: undefined },
    ]);
    expect(page.result).toMatchObject({
      count: 1,
      sessions: [{ key: activeKey, archived: false }],
    });
    expect(page.selectedKeys).toEqual(new Set([activeKey, unknownKey]));
    expect(page.error).toBe(retryError);
    expect(page.error).not.toContain("GatewayRequestError");
  });

  it("stops an active cloud worker and refreshes the session roster", async () => {
    const stopped = createDeferred<{ ok: true }>();
    const request = vi.fn(() => stopped.promise);
    const managed = createManagedSessions();
    const { gateway } = createGateway({ request } as unknown as GatewayBrowserClient);
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
    const page = await createRenderedPage(createContext(gateway, managed.sessions), {
      count: 1,
      sessions: [row],
    } as SessionsListResult);
    const query = vi.mocked(managed.subscribeList).mock.calls[0]?.[0];
    if (!query) {
      throw new Error("Expected a managed query subscription");
    }
    managed.refreshList.mockClear();
    vi.mocked(showConfirmDialog).mockResolvedValue(true);

    const stopping = page.stopCloudWorker(row);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    managed.publish(query, {
      result: {
        count: 1,
        sessions: [{ ...row, label: "Updated while stopping" }],
      } as SessionsListResult,
      agentId: "main",
      loading: false,
      error: null,
    });
    expect(page.sessionMutationPending).toBe(true);
    expect(page.result?.sessions[0]?.label).toBe("Updated while stopping");
    stopped.resolve({ ok: true });
    await stopping;

    expect(showConfirmDialog).toHaveBeenCalledWith({
      message: 'Stop the cloud worker for "Cloud task"?',
      confirmLabel: "Stop worker",
      danger: true,
    });
    expect(request).toHaveBeenCalledWith(
      "sessions.reclaim",
      { key: "agent:main:cloud", agentId: "main" },
      { timeoutMs: null },
    );
    expect(managed.refreshList).toHaveBeenCalledWith({ ...query, force: true });
    expect(page.result?.sessions[0]?.label).toBe("Updated while stopping");
    expect(page.sessionMutationPending).toBe(false);
  });

  it("reclaims a pending cloud worker through its session", async () => {
    const request = vi.fn(() => Promise.resolve({ ok: true }));
    const managed = createManagedSessions();
    const { gateway } = createGateway({ request } as unknown as GatewayBrowserClient);
    const page = await createPage(createContext(gateway, managed.sessions));
    managed.refreshList.mockClear();
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
    expect(request).toHaveBeenCalledWith(
      "sessions.reclaim",
      { key: "agent:main:cloud", agentId: "main" },
      { timeoutMs: null },
    );
    expect(managed.refreshList).toHaveBeenCalledOnce();
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
    expect(page.error).toBe("group name exceeds 512 characters");
  });

  it("drops stale mutation state, errors, and navigation after disconnect", async () => {
    const deleted = createDeferred<{
      deleted: string[];
      errors: string[];
      preservedWorktrees: PreservedSessionWorktree[];
    }>();
    const patched = createDeferred<unknown>();
    const forked = createDeferred<string | null>();
    const branched = createDeferred<{ key: string }>();
    const restored = createDeferred<unknown>();
    const groupsPut = createDeferred<Awaited<ReturnType<SessionCapability["groupsPut"]>>>();
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
      return Promise.resolve({});
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const mutableGateway = createGateway(client);
    const context = createContext(mutableGateway.gateway, sessions);
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
      page.rememberCustomGroup("Stale group"),
    ];
    await vi.waitFor(() => expect(sessions.deleteMany).toHaveBeenCalledOnce());

    mutableGateway.emit({ phase: "reconnecting", client });
    deleted.resolve({ deleted: ["main"], errors: ["stale delete error"], preservedWorktrees: [] });
    patched.resolve({ ok: true });
    forked.resolve("forked");
    branched.resolve({ key: "branched" });
    restored.reject(new Error("stale restore error"));
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
    const forked = createDeferred<string | null>();
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
