// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { INTERNAL_SESSION_PATH_PARAM } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { prepareSessionNavigationHandoff } from "../../lib/sessions/navigation-handoff.ts";
import {
  resolveSessionPreferredFaceForKey,
  SESSION_FACE_PREFERENCE_PARAM,
  SESSION_NAVIGATION_KEY_PARAM,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { patchChatSessionLabel } from "./chat-state-route.ts";
import { loadChatRoute } from "./route-loader.ts";

const uuid = "12345678-90ab-cdef-1234-567890abcdef";
const sessionKey = `agent:roboclaw:thread:${uuid}`;

function row(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: sessionKey,
    kind: "direct",
    updatedAt: 1,
    displayName: "Default mode with rare surprises",
    sessionId: "fedcba98-7654-3210-fedc-ba9876543210",
    ...overrides,
  };
}

function result(
  sessions: GatewaySessionRow[],
  options: Pick<SessionsListResult, "hasMore" | "nextOffset" | "offset"> = {},
): SessionsListResult {
  return {
    ts: 1,
    path: "sessions.json",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
    ...options,
  };
}

function contextFor(
  listResult: (options: {
    search?: string;
    offset?: number;
    agentId?: string;
  }) => SessionsListResult | null,
  cachedSessions: GatewaySessionRow[] = [],
) {
  const client = {};
  const list = vi.fn(async (options: { search?: string; offset?: number } = {}) =>
    listResult(options),
  );
  const context = {
    basePath: "",
    gateway: {
      snapshot: { phase: "connected", client, hello: null },
      subscribe: vi.fn(() => () => undefined),
    },
    agents: { state: { agentsList: { mainKey: "main" } } },
    agentSelection: { state: { selectedId: "roboclaw" } },
    sessions: { state: { result: result(cachedSessions) }, list },
  } as unknown as ApplicationContext;
  return { context, list };
}

function installShortResolver(
  context: ApplicationContext,
  rows: GatewaySessionRow[],
  resolved: { ok: true; key: string } | { ok: false; candidates?: Array<{ key: string }> } = rows[0]
    ? { ok: true, key: rows[0].key }
    : { ok: false },
) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "sessions.resolve") {
      return resolved;
    }
    if (method === "sessions.describe") {
      return { session: rows.find((candidate) => candidate.key === params.key) ?? null };
    }
    throw new Error(`Unexpected gateway request: ${method}`);
  });
  (context.gateway.snapshot.client as unknown as { request: typeof request }).request = request;
  return request;
}

// The router navigates with `options`, not the shareable `href`, so route-loader
// coverage has to start from the same location the app actually pushes.
function targetLocation(target: ReturnType<typeof sessionNavigationTarget>) {
  return { pathname: target.options.pathname, search: target.options.search ?? "", hash: "" };
}

describe("gateway-backed session route resolution", () => {
  it("patches a canonical global session on the selected agent", async () => {
    const patch = vi.fn(async () => ({}));
    const state = {
      sessionKey: "global",
      assistantAgentId: "research",
      agentsList: null,
      hello: null,
    } as ChatPageHost;

    const sessions = { patch } as unknown as Pick<SessionCapability, "patch">;

    await patchChatSessionLabel(state, sessions, "global", "Research thread");

    expect(patch).toHaveBeenCalledWith(
      "global",
      { label: "Research thread" },
      { agentId: "research" },
    );
  });

  it("resolves a non-default agent's canonical global face from its scoped row", async () => {
    const globalRow = row({ key: "global", kind: "global", boardFace: "dashboard" });
    const { context, list } = contextFor(({ agentId, search }) =>
      agentId === "research" && search === "global" ? result([globalRow]) : result([]),
    );
    context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [],
    };
    context.gateway.snapshot.hello = {
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "main",
          mainKey: "main",
          mainSessionKey: "global",
        },
      },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];

    await expect(
      loadChatRoute(
        context,
        {
          pathname: "/chat/research",
          search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
          hash: "",
        },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: "session",
      sessionKey: "global",
      agentId: "research",
      draft: undefined,
      face: "dashboard",
      canonicalLocation: { pathname: "/dashboard/research", search: "", hash: "" },
      canonicalLocationSource: {
        pathname: "/chat/research",
        search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
        hash: "",
      },
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "research", search: "global" }),
    );
  });

  it("applies an uncached stored face to a preference-derived open", async () => {
    const dashboardRow = row({ boardFace: "dashboard" });
    const { context } = contextFor(() => result([dashboardRow]));
    installShortResolver(context, [dashboardRow]);
    const face = resolveSessionPreferredFaceForKey(context, dashboardRow.key);
    const target = sessionNavigationTarget({
      context,
      face,
      sessionKey: dashboardRow.key,
      preferenceDerivedFace: true,
    });

    expect(face).toBe("chat");
    expect(target.options.pathname).toBe("/chat/roboclaw/12345678");
    await expect(
      loadChatRoute(context, targetLocation(target), face, new AbortController().signal),
    ).resolves.toMatchObject({
      kind: "session",
      sessionKey: dashboardRow.key,
      // The loader adopts the stored face, so the page renders the dashboard board and
      // replaces the URL into the matching namespace.
      face: "dashboard",
      canonicalLocation: {
        pathname: "/dashboard/roboclaw/default-mode-with-rare-surprises-12345678",
        search: "",
      },
    });
  });

  it("keeps a preference-derived main route usable when its optional lookup is unavailable", async () => {
    const { context } = contextFor(() => null);
    const target = sessionNavigationTarget({
      context,
      face: "chat",
      sessionKey: "agent:roboclaw:main",
      preferenceDerivedFace: true,
    });

    await expect(
      loadChatRoute(context, targetLocation(target), "chat", new AbortController().signal),
    ).resolves.toEqual({
      kind: "session",
      sessionKey: "agent:roboclaw:main",
      draft: undefined,
      face: "chat",
      canonicalLocation: { pathname: "/chat/roboclaw", search: "", hash: "" },
      canonicalLocationSource: targetLocation(target),
    });
  });

  it("applies face canonicalization through the router's normalized location", async () => {
    const dashboardRow = row({ boardFace: "dashboard" });
    const { context } = contextFor(() => result([dashboardRow]));
    installShortResolver(context, [dashboardRow]);
    const target = sessionNavigationTarget({
      context,
      face: "chat",
      sessionKey: dashboardRow.key,
      preferenceDerivedFace: true,
    });
    const search = new URLSearchParams(targetLocation(target).search);
    search.set(INTERNAL_SESSION_PATH_PARAM, target.options.pathname);

    await expect(
      loadChatRoute(
        context,
        { pathname: "/chat", search: `?${search.toString()}`, hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: "session",
      sessionKey: dashboardRow.key,
      canonicalLocation: {
        pathname: "/dashboard/roboclaw/default-mode-with-rare-surprises-12345678",
        search: "",
      },
    });
  });

  it("applies an uncached stored face to a preference-derived catalog open", async () => {
    const catalogKey = buildCatalogSessionKey({
      catalogId: "claude",
      hostId: "gateway:local",
      threadId: "thread-1",
    });
    const catalogRow = row({ key: catalogKey, boardFace: "dashboard" });
    const { context } = contextFor(() => result([catalogRow]));
    const target = sessionNavigationTarget({
      face: "chat",
      sessionKey: catalogKey,
      fallbackAgentId: "roboclaw",
      preferenceDerivedFace: true,
    });

    await expect(
      loadChatRoute(context, targetLocation(target), "chat", new AbortController().signal),
    ).resolves.toEqual({
      kind: "session",
      sessionKey: catalogKey,
      agentId: "roboclaw",
      draft: undefined,
      face: "dashboard",
      canonicalLocation: {
        pathname: "/dashboard/roboclaw",
        search: "?catalog=claude&host=gateway%3Alocal&thread=thread-1",
        hash: "",
      },
      canonicalLocationSource: targetLocation(target),
    });
  });

  it("never lets a stored preference rewrite an explicitly chosen face", async () => {
    for (const [face, storedFace] of [
      ["chat", "dashboard"],
      ["dashboard", "chat"],
    ] as const) {
      const storedRow = row({ boardFace: storedFace });
      const { context } = contextFor(() => result([storedRow]));
      installShortResolver(context, [storedRow]);
      const pathname = `/${face}/roboclaw/default-mode-with-rare-surprises-12345678`;
      const loaded = await loadChatRoute(
        context,
        { pathname, search: "", hash: "" },
        face,
        new AbortController().signal,
      );

      expect(loaded).toMatchObject({ kind: "session", sessionKey: storedRow.key, face });
      expect(loaded).not.toHaveProperty("canonicalLocation");
    }
  });

  it("resolves an exact display-name slug and canonicalizes it to a full reference", async () => {
    const storedRow = row();
    const { context, list } = contextFor(({ search }) =>
      search === "surprises" ? result([storedRow]) : result([]),
    );
    const loaded = await loadChatRoute(
      context,
      {
        pathname: "/chat/roboclaw/default-mode-with-rare-surprises",
        search: "",
        hash: "",
      },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({
      kind: "session",
      sessionKey: storedRow.key,
      canonicalLocation: {
        // Canonicalizes to the same short reference every other surface links to.
        pathname: "/chat/roboclaw/default-mode-with-rare-surprises-12345678",
      },
    });
    expect(list.mock.calls.map(([options]) => options?.search)).toEqual([
      "agent:roboclaw:default-mode-with-rare-surprises",
      "surprises",
    ]);
  });

  it("resolves a slug whose display name separators were punctuation", async () => {
    // The gateway search is a plain substring match, so a joined "fix auth bug" needle
    // would never match "Fix: auth bug"; the longest slug token still does.
    const storedRow = row({ displayName: "Fix: auth bug" });
    const { context, list } = contextFor(({ search }) =>
      search === "auth" ? result([storedRow]) : result([]),
    );
    const loaded = await loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/fix-auth-bug", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: storedRow.key });
    expect(list.mock.calls.map(([options]) => options?.search)).toEqual([
      "agent:roboclaw:fix-auth-bug",
      "auth",
    ]);
  });

  it("waits for cold gateway defaults before resolving a display-name slug", async () => {
    type GatewayListener = Parameters<ApplicationContext["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    let snapshot = {
      phase: "connecting",
      client: null,
      hello: null,
    } as unknown as ApplicationContext["gateway"]["snapshot"];
    const storedRow = row();
    const list = vi.fn(async (options: { search?: string } = {}) =>
      options.search === "surprises" ? result([storedRow]) : result([]),
    );
    const context = {
      basePath: "",
      gateway: {
        get snapshot() {
          return snapshot;
        },
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      agents: { state: { agentsList: null } },
      sessions: { state: { result: result([]) }, list },
    } as unknown as ApplicationContext;
    const pending = loadChatRoute(
      context,
      {
        pathname: "/chat/roboclaw/default-mode-with-rare-surprises",
        search: "",
        hash: "",
      },
      "chat",
      new AbortController().signal,
    );
    await Promise.resolve();

    snapshot = {
      phase: "connected",
      client: {},
      hello: { snapshot: { sessionDefaults: { mainKey: "main" } } },
    } as unknown as ApplicationContext["gateway"]["snapshot"];
    const connectedListener = listener as GatewayListener | null;
    if (!connectedListener) {
      throw new Error("expected gateway readiness subscription");
    }
    connectedListener(snapshot);

    await expect(pending).resolves.toMatchObject({
      kind: "session",
      sessionKey: storedRow.key,
      canonicalLocation: {
        // Canonicalizes to the same short reference every other surface links to.
        pathname: "/chat/roboclaw/default-mode-with-rare-surprises-12345678",
      },
    });
  });

  it("returns slug ties to the existing disambiguation view", async () => {
    const rows = [
      row({ key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001" }),
      row({ key: "agent:research:thread:12345678-0bbb-4000-8000-000000000002" }),
    ];
    const { context } = contextFor(({ search }) =>
      search === "surprises" ? result(rows) : result([]),
    );
    const loaded = await loadChatRoute(
      context,
      {
        pathname: "/chat/roboclaw/default-mode-with-rare-surprises",
        search: "",
        hash: "",
      },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({
      kind: "ambiguous",
      shortId: "default-mode-with-rare-surprises",
      truncated: false,
      candidates: [{ agentId: "roboclaw" }, { agentId: "research" }],
    });
    if (!("kind" in loaded) || loaded.kind !== "ambiguous") {
      throw new Error("expected slug disambiguation");
    }
    // Slug ties reuse the short-id disambiguation prefix instead of a full uuid, so the
    // offered links stay as short as uniqueness allows.
    expect(loaded.candidates.map((candidate) => candidate.href)).toEqual([
      "/chat/roboclaw/default-mode-with-rare-surprises-123456780a",
      "/chat/research/default-mode-with-rare-surprises-123456780b",
    ]);
  });

  it("settles a shared short-id prefix with the slug the link carries", async () => {
    const rows = [
      row({ key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001" }),
      row({
        key: "agent:roboclaw:thread:12345678-0bbb-4000-8000-000000000002",
        displayName: "Deploy monitor",
      }),
    ];
    const { context } = contextFor(() => result(rows));
    const request = installShortResolver(context, rows, { ok: true, key: rows[1]?.key ?? "" });
    const loaded = await loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/deploy-monitor-12345678", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    // Both ids start with 12345678; the slug says which one, so the short link still
    // resolves instead of bouncing to the chooser.
    expect(loaded).toMatchObject({ kind: "session", sessionKey: rows[1]?.key });
    expect(request).toHaveBeenNthCalledWith(1, "sessions.resolve", {
      shortId: "12345678",
      slugHint: "deploy-monitor",
      agentId: "roboclaw",
      allowMissing: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.describe", { key: rows[1]?.key });
  });

  it("falls back to the prior list resolver when an older gateway rejects shortId", async () => {
    const storedRow = row({
      key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001",
      displayName: "Deploy monitor",
    });
    const { context, list } = contextFor(({ search }) =>
      search === "12345678" ? result([storedRow]) : result([]),
    );
    const request = vi.fn(async () => {
      throw new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "invalid sessions.resolve params: at root: unexpected property 'shortId'",
      });
    });
    (context.gateway.snapshot.client as unknown as { request: typeof request }).request = request;

    const loaded = await loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/deploy-monitor-123456780a", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: storedRow.key });
    expect(request).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith({
      agentId: "roboclaw",
      archivedFilter: "all",
      includeDerivedTitles: true,
      limit: 20,
      search: "12345678",
    });
  });

  it("does not invoke the list fallback when the gateway resolver succeeds", async () => {
    const storedRow = row({ displayName: "Deploy monitor" });
    const { context, list } = contextFor(() => result([storedRow]));
    const request = installShortResolver(context, [storedRow]);

    const loaded = await loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/deploy-monitor-12345678", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: storedRow.key });
    expect(request).toHaveBeenCalledTimes(2);
    expect(list).not.toHaveBeenCalled();
  });

  it("does not mask unrelated sessions.resolve validation errors", async () => {
    const { context, list } = contextFor(() => result([]));
    const rejection = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "invalid sessions.resolve params: shortId must be hexadecimal",
    });
    const request = vi.fn(async () => {
      throw rejection;
    });
    (context.gateway.snapshot.client as unknown as { request: typeof request }).request = request;

    await expect(
      loadChatRoute(
        context,
        { pathname: "/chat/roboclaw/deploy-monitor-12345678", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).rejects.toBe(rejection);
    expect(list).not.toHaveBeenCalled();
  });

  it("uses the sidebar-carried full key without issuing a session search", async () => {
    const storedRow = row({ displayName: "Deploy monitor" });
    const { context, list } = contextFor(() => result([storedRow]));
    const target = sessionNavigationTarget({
      face: "chat",
      sessionKey: storedRow.key,
      fallbackAgentId: "roboclaw",
      row: storedRow,
    });
    prepareSessionNavigationHandoff(context.gateway, target.options.pathname, storedRow.key);
    const loaded = await loadChatRoute(
      context,
      { pathname: target.options.pathname, search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({
      kind: "session",
      sessionKey: storedRow.key,
    });
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    {
      connectionChange: "gateway client replacement",
      replaceConnection: (snapshot: ApplicationContext["gateway"]["snapshot"]) => {
        const request = (snapshot.client as { request?: unknown } | null)?.request;
        snapshot.client = { request } as NonNullable<typeof snapshot.client>;
      },
    },
    {
      connectionChange: "hello replacement on the same gateway client",
      replaceConnection: (snapshot: ApplicationContext["gateway"]["snapshot"]) => {
        snapshot.hello = {
          snapshot: { sessionDefaults: { mainKey: "main" } },
        } as NonNullable<typeof snapshot.hello>;
      },
    },
  ])("does not trust a carried session after $connectionChange", async ({ replaceConnection }) => {
    const oldSession = row({
      key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001",
      displayName: "Deploy monitor",
    });
    const currentSession = row({
      key: "agent:roboclaw:thread:12345678-0bbb-4000-8000-000000000002",
      displayName: "Deploy monitor",
    });
    const { context, list } = contextFor(() => result([currentSession]));
    const request = installShortResolver(context, [currentSession]);
    context.gateway.snapshot.hello = {
      snapshot: { sessionDefaults: { mainKey: "main" } },
    } as NonNullable<typeof context.gateway.snapshot.hello>;
    const pathname = "/chat/roboclaw/deploy-monitor-12345678";

    prepareSessionNavigationHandoff(context.gateway, pathname, oldSession.key);
    replaceConnection(context.gateway.snapshot);

    const loaded = await loadChatRoute(
      context,
      { pathname, search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: currentSession.key });
    expect(list).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("prefers the current location key over a residual colliding handoff", async () => {
    const current = row({
      key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001",
      displayName: "Deploy monitor",
    });
    const residual = row({
      key: "agent:roboclaw:thread:12345678-0bbb-4000-8000-000000000002",
      displayName: "Deploy monitor",
    });
    const { context, list } = contextFor(() => result([current, residual]), [current, residual]);
    const pathname = "/chat/roboclaw/deploy-monitor-12345678";
    prepareSessionNavigationHandoff(context.gateway, pathname, residual.key);

    const loaded = await loadChatRoute(
      context,
      {
        pathname,
        search: `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(current.key)}`,
        hash: "",
      },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: current.key });
    expect(list).not.toHaveBeenCalled();

    const canonicalReload = await loadChatRoute(
      context,
      { pathname, search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );
    expect(canonicalReload).toMatchObject({ kind: "session", sessionKey: current.key });
    expect(list).not.toHaveBeenCalled();
  });

  it("does not trust a URL-only full key that is absent from cached rows", async () => {
    const expected = row({
      key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001",
      displayName: "Deploy monitor",
    });
    const staleKey = "agent:roboclaw:thread:12345678-0bbb-4000-8000-000000000002";
    const { context, list } = contextFor(() => result([expected]));
    const request = installShortResolver(context, [expected]);

    const loaded = await loadChatRoute(
      context,
      {
        pathname: "/chat/roboclaw/deploy-monitor-12345678",
        search: `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(staleKey)}`,
        hash: "",
      },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: expected.key });
    expect(list).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps a cold cached short route on the authoritative resolution path", async () => {
    const storedRow = row({ displayName: "Deploy monitor" });
    const { context, list } = contextFor(() => result([storedRow]), [storedRow]);
    const request = installShortResolver(context, [storedRow]);

    const loaded = await loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/deploy-monitor-12345678", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: storedRow.key });
    expect(list).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps the gateway ambiguity check when cached rows share the uuid and slug", async () => {
    const rows = [
      row({ key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001" }),
      row({ key: "agent:roboclaw:thread:12345678-0bbb-4000-8000-000000000002" }),
    ];
    const { context, list } = contextFor(() => result(rows), rows);
    const request = installShortResolver(context, rows, {
      ok: false,
      candidates: rows.map(({ key }) => ({ key })),
    });

    const loaded = await loadChatRoute(
      context,
      {
        pathname: "/chat/roboclaw/default-mode-with-rare-surprises-12345678",
        search: "",
        hash: "",
      },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "ambiguous", shortId: "12345678" });
    expect(list).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("keeps the chooser when the slug matches neither or both tied sessions", async () => {
    const rows = [
      row({ key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001" }),
      row({ key: "agent:roboclaw:thread:12345678-0bbb-4000-8000-000000000002" }),
    ];
    const { context } = contextFor(() => result(rows));
    installShortResolver(context, rows, {
      ok: false,
      candidates: rows.map(({ key }) => ({ key })),
    });
    for (const pathname of [
      // Stale slug: the session was renamed since the link was made.
      "/chat/roboclaw/an-old-name-12345678",
      // Both tied sessions share the slug, so it cannot decide.
      "/chat/roboclaw/default-mode-with-rare-surprises-12345678",
    ]) {
      const loaded = await loadChatRoute(
        context,
        { pathname, search: "", hash: "" },
        "chat",
        new AbortController().signal,
      );

      expect(loaded).toMatchObject({ kind: "ambiguous", shortId: "12345678" });
    }
  });

  it("treats a full ten-candidate response as conservatively truncated", async () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      row({
        key: `agent:roboclaw:thread:12345678-${index.toString(16).padStart(4, "0")}-4000-8000-000000000000`,
        displayName: `Candidate ${index}`,
      }),
    );
    const { context } = contextFor(() => result([]));
    installShortResolver(context, rows, {
      ok: false,
      candidates: rows.map(({ key }) => ({ key })),
    });
    const loaded = await loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/12345678", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "ambiguous", shortId: "12345678", truncated: true });
  });

  it("returns not found when the gateway has no short-id match", async () => {
    const { context, list } = contextFor(() => result([]));
    const request = installShortResolver(context, [], { ok: false });

    const loaded = await loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/deadbeef", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).not.toHaveProperty("kind", "session");
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "roboclaw", search: "agent:roboclaw:deadbeef" }),
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("opens a mechanically composed single-segment UUID as its exact session key", async () => {
    const literalKey = `agent:main:${uuid}`;
    const literalRow = row({ key: literalKey, displayName: undefined });
    const { context, list } = contextFor(({ agentId, search }) =>
      agentId === "main" && search === literalKey ? result([literalRow]) : result([]),
    );
    const request = installShortResolver(context, [], { ok: false });

    const loaded = await loadChatRoute(
      context,
      { pathname: `/chat/main/${uuid}`, search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({
      kind: "session",
      sessionKey: literalKey,
      canonicalLocation: { pathname: "/chat/main/12345678" },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", search: literalKey }),
    );
  });

  it("uses forced-literal URLs to avoid a colliding short session reference", async () => {
    const literalUuid = "12345678-90ab-cdef-1234-567890abcdef";
    const collidingUuid = "567890ab-cdef-4321-8765-43210fedcba9";
    const literal = row({
      key: `agent:main:${literalUuid}`,
      sessionId: literalUuid,
      displayName: undefined,
    });
    const shortMatch = row({
      key: `agent:main:thread:${collidingUuid}`,
      sessionId: collidingUuid,
      displayName: undefined,
    });
    const { context } = contextFor(({ agentId, search }) =>
      agentId === "main" && search === literal.key ? result([literal]) : result([]),
    );
    const request = installShortResolver(context, [literal, shortMatch], {
      ok: true,
      key: shortMatch.key,
    });

    await expect(
      loadChatRoute(
        context,
        { pathname: `/chat/main/~key/${literalUuid}`, search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ kind: "session", sessionKey: literal.key });

    // Plain literal paths remain short-first, so this collision opens the short match.
    // Tool-generated links advertise `~key` to bypass that intentional ambiguity.
    await expect(
      loadChatRoute(
        context,
        { pathname: `/chat/main/${literalUuid}`, search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ kind: "session", sessionKey: shortMatch.key });
    expect(request).toHaveBeenCalledWith(
      "sessions.resolve",
      expect.objectContaining({ shortId: "567890abcdef" }),
    );
  });

  it("prefers an exact literal key over slug matches", async () => {
    const literal = row({
      key: "agent:roboclaw:default-mode-with-rare-surprises",
      displayName: "Literal session",
    });
    const slug = row();
    const { context, list } = contextFor(() => result([slug, literal]));
    const loaded = await loadChatRoute(
      context,
      {
        pathname: "/chat/roboclaw/default-mode-with-rare-surprises",
        search: "",
        hash: "",
      },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: literal.key });
    expect(list).toHaveBeenCalledOnce();
  });

  it("prefers a short-id shape over a display-name slug", async () => {
    const short = row({ key: "agent:roboclaw:thread:deadbeef-0aaa-4000-8000-000000000001" });
    const slug = row({
      key: "agent:roboclaw:thread:12345678-0bbb-4000-8000-000000000002",
      displayName: "Default mode deadbeef",
    });
    const { context, list } = contextFor(() => result([slug, short]));
    const request = installShortResolver(context, [short]);
    const loaded = await loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/default-mode-deadbeef", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: short.key });
    expect(list).not.toHaveBeenCalled();
    expect(request).toHaveBeenNthCalledWith(1, "sessions.resolve", {
      shortId: "deadbeef",
      slugHint: "default-mode",
      agentId: "roboclaw",
      allowMissing: true,
    });
  });

  it("returns not found when neither a literal key nor slug resolves", async () => {
    const { context, list } = contextFor(() => result([]));
    const loaded = await loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/unknown-thread", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).not.toHaveProperty("kind", "session");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("resolves a cached literal without a gateway round-trip", async () => {
    const literal = row({ key: "agent:roboclaw:standup", displayName: "Standup" });
    const { context, list } = contextFor(() => result([literal]), [literal]);
    const loaded = await loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/standup", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({ kind: "session", sessionKey: literal.key });
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps an authoritative literal usable when best-effort lookup is unavailable", async () => {
    const { context, list } = contextFor(() => null);
    const loaded = await loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/existing-literal", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toEqual({
      kind: "session",
      sessionKey: "agent:roboclaw:existing-literal",
      draft: undefined,
      face: "chat",
    });
    expect(list).toHaveBeenCalledOnce();
  });

  it("keeps an authoritative literal when its exact search is truncated", async () => {
    const { context, list } = contextFor(({ offset = 0 }) =>
      result([], { hasMore: true, nextOffset: offset + 20, offset }),
    );
    const loaded = await loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/existing-literal", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toEqual({
      kind: "session",
      sessionKey: "agent:roboclaw:existing-literal",
      draft: undefined,
      face: "chat",
    });
    expect(list).toHaveBeenCalledTimes(5);
  });
});
