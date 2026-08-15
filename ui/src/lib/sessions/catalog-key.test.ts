import { describe, expect, it, vi } from "vitest";
import {
  buildCatalogSessionKey,
  catalogSessionKeyFromSearch,
  catalogSessionSearch,
  lookupCatalogSession,
  parseCatalogSessionKey,
} from "./catalog-key.ts";

describe("catalog session keys", () => {
  it("round-trips encoded host and thread ids", () => {
    const key = { catalogId: "claude", hostId: "node:abc", threadId: "thread:a/b" };
    expect(parseCatalogSessionKey(buildCatalogSessionKey(key))).toEqual(key);
  });

  it.each(["", "catalog:", "catalog:a:b", "catalog:a:b:c:d", "catalog:a:%:c"])(
    "rejects %s",
    (value) => expect(parseCatalogSessionKey(value)).toBeNull(),
  );

  it("round-trips a catalog thread URL target", () => {
    const key = { catalogId: "claude", hostId: "node:abc", threadId: "thread:a/b" };
    expect(catalogSessionKeyFromSearch(catalogSessionSearch(key))).toEqual(key);
  });

  it("keeps the explicit agent owner across paginated lookup requests", async () => {
    const key = { catalogId: "codex", hostId: "gateway:local", threadId: "thread-2" };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        catalogs: [
          {
            id: "codex",
            label: "Codex",
            capabilities: {},
            hosts: [
              {
                hostId: "gateway:local",
                label: "Gateway",
                kind: "gateway",
                connected: true,
                sessions: [],
                nextCursor: "next",
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        catalogs: [
          {
            id: "codex",
            label: "Codex",
            capabilities: {},
            hosts: [
              {
                hostId: "gateway:local",
                label: "Gateway",
                kind: "gateway",
                connected: true,
                sessions: [
                  {
                    threadId: "thread-2",
                    status: "idle",
                    archived: false,
                    canContinue: true,
                    canArchive: true,
                  },
                ],
              },
            ],
          },
        ],
      });

    const result = await lookupCatalogSession({
      client: { request } as never,
      key,
      agentId: "jarvis",
      isCurrent: () => true,
    });

    expect(result?.session?.threadId).toBe("thread-2");
    expect(request).toHaveBeenNthCalledWith(1, "sessions.catalog.list", {
      agentId: "jarvis",
      catalogId: "codex",
      hostIds: ["gateway:local"],
      limitPerHost: 100,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.catalog.list", {
      agentId: "jarvis",
      catalogId: "codex",
      hostIds: ["gateway:local"],
      limitPerHost: 100,
      cursors: { "gateway:local": "next" },
    });
  });
});
