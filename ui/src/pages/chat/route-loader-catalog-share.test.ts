// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { loadChatRoute } from "./route-loader.ts";

const fullId = "0123456789abcdef0123456789abcdef";
const SHARE_ROUTE = {
  kind: "thread-id-prefix",
  routeSegment: "beam",
  hostId: "gateway",
  identifierAlphabet: "lowercase-hex",
  fullLength: 32,
  minPrefixLength: 12,
  lookup: "catalog-list-search-by-thread-id-prefix",
  ambiguity: "multiple-results-or-next-cursor",
} as const;

function catalogContext(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  basePath = "",
): ApplicationContext {
  return {
    basePath,
    gateway: {
      snapshot: { phase: "connected", client: { request }, hello: null },
      subscribe: vi.fn(() => () => undefined),
    },
    agents: { state: { agentsList: { defaultId: "research", mainKey: "main" } } },
    agentSelection: { state: { selectedId: "research" } },
    sessions: { state: { result: null } },
  } as unknown as ApplicationContext;
}

function beamCatalog(sessions: Array<{ threadId: string; name: string }>, nextCursor?: string) {
  return {
    catalogs: [
      {
        id: "beam",
        label: "Beam",
        capabilities: { continueSession: false, archive: false },
        shareRoute: SHARE_ROUTE,
        hosts: [
          {
            hostId: "gateway",
            label: "Beamed sessions",
            kind: "gateway",
            connected: true,
            sessions: sessions.map((session) => ({
              ...session,
              status: "live",
              archived: false,
              canContinue: false,
              canArchive: false,
            })),
            ...(nextCursor ? { nextCursor } : {}),
          },
        ],
      },
    ],
  };
}

describe("catalog share route resolution", () => {
  it("resolves an external-style provider descriptor without catalog-specific UI policy", async () => {
    const shareRoute = { ...SHARE_ROUTE, routeSegment: "shared-sessions" } as const;
    const request = vi.fn(async () => {
      const result = beamCatalog([{ threadId: fullId, name: "External session" }]);
      return {
        catalogs: [
          {
            ...result.catalogs[0],
            id: "external",
            label: "External",
            shareRoute,
          },
        ],
      };
    });

    await expect(
      loadChatRoute(
        catalogContext(request),
        { pathname: "/shared-sessions/0123456789ab", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: "session",
      sessionKey: `agent:research:catalog:external:gateway:${fullId}`,
    });
  });

  it("resolves a base-path share independently of the default agent id", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.catalog.list") {
        throw new Error(`Unexpected gateway request: ${method}`);
      }
      return beamCatalog([{ threadId: fullId, name: "Pretty Beam route" }]);
    });

    const loaded = await loadChatRoute(
      catalogContext(request, "/openclaw"),
      { pathname: "/openclaw/beam/0123456789ab", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toMatchObject({
      kind: "session",
      sessionKey: `agent:research:catalog:beam:gateway:${fullId}`,
      agentId: "research",
      face: "chat",
    });
    expect(loaded).not.toHaveProperty("canonicalLocation");
    expect(request).toHaveBeenCalledWith("sessions.catalog.list", {
      agentId: "research",
      search: "0123456789ab",
      limitPerHost: 2,
    });
  });

  it("keeps ambiguity, invalid ids, and disabled route owners visible", async () => {
    const ids = ["0123456789ab00000000000000000000", "0123456789abffffffffffffffffffff"];
    const request = vi.fn(async (_method: string, params: Record<string, unknown>) =>
      beamCatalog(
        params.search === "0123456789ab"
          ? ids.map((threadId, index) => ({
              threadId,
              name: `Candidate ${String(index + 1)}`,
            }))
          : [],
        params.search === "0123456789ab" ? "more" : undefined,
      ),
    );
    const context = catalogContext(request);

    await expect(
      loadChatRoute(
        context,
        { pathname: "/beam/0123456789ab", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: "ambiguous",
      shortId: "0123456789ab",
      candidates: [{ href: `/beam/${ids[0]}` }, { href: `/beam/${ids[1]}` }],
      truncated: true,
    });

    await expect(
      loadChatRoute(
        context,
        { pathname: "/beam/aaaaaaaaaaaa", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: "missing-session",
      currentSessionHref: "/chat/research",
      sessionsHref: "/sessions",
    });

    await expect(
      loadChatRoute(
        context,
        { pathname: "/beam/ABCDEF012345", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: "route-error",
      message: "This Beam share URL is invalid.",
    });

    const disabled = catalogContext(vi.fn(async () => ({ catalogs: [] })));
    await expect(
      loadChatRoute(
        disabled,
        { pathname: "/beam/0123456789ab", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: "route-error",
      message: "This shared session route is unavailable.",
    });

    const duplicated = catalogContext(
      vi.fn(async () => {
        const result = beamCatalog([{ threadId: fullId, name: "First" }]);
        return { catalogs: [...result.catalogs, { ...result.catalogs[0], id: "other" }] };
      }),
    );
    await expect(
      loadChatRoute(
        duplicated,
        { pathname: "/beam/0123456789ab", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ kind: "route-error" });
  });

  it("keeps paginated empty results ambiguous and rejects duplicate declared hosts", async () => {
    const paginated = catalogContext(vi.fn(async () => beamCatalog([], "more")));
    await expect(
      loadChatRoute(
        paginated,
        { pathname: "/beam/0123456789ab", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ kind: "ambiguous", candidates: [], truncated: true });

    const duplicateHost = catalogContext(
      vi.fn(async () => {
        const result = beamCatalog([{ threadId: fullId, name: "First" }]);
        const catalog = result.catalogs[0];
        if (!catalog) {
          throw new Error("catalog fixture missing");
        }
        return {
          catalogs: [{ ...catalog, hosts: [...catalog.hosts, { ...catalog.hosts[0] }] }],
        };
      }),
    );
    await expect(
      loadChatRoute(
        duplicateHost,
        { pathname: "/beam/0123456789ab", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ kind: "route-error" });
  });
});
