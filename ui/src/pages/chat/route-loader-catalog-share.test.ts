// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { loadChatRoute } from "./route-loader.ts";

const fullId = "0123456789abcdef0123456789abcdef";

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
  } as unknown as ApplicationContext;
}

function beamCatalog(sessions: Array<{ threadId: string; name: string }>, nextCursor?: string) {
  return {
    catalogs: [
      {
        id: "beam",
        label: "Beam",
        capabilities: { continueSession: false, archive: false },
        shareRoute: { routeSegment: "beam", hostId: "gateway" },
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
      sessionKey: buildCatalogSessionKey({
        catalogId: "beam",
        hostId: "gateway",
        threadId: fullId,
      }),
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
      kind: "route-error",
      message: "Beam session aaaaaaaaaaaa was not found.",
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
});
