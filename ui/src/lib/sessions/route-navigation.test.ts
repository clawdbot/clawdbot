import { buildControlUiCatalogSessionUrl } from "@openclaw/session-url-contract";
import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import { buildCatalogSessionKey } from "./catalog-key.ts";
import {
  resolveSessionPreferredFace,
  resolveSessionPreferredFaceForKey,
  SESSION_FACE_PREFERENCE_PARAM,
  SESSION_NAVIGATION_KEY_PARAM,
  sessionNavigationTarget,
} from "./route-navigation.ts";

describe("sessionNavigationTarget", () => {
  it("defaults generic opens to chat and honors a stored dashboard preference", () => {
    expect(resolveSessionPreferredFace(undefined)).toBe("chat");
    expect(resolveSessionPreferredFace({ boardFace: "chat" })).toBe("chat");
    expect(resolveSessionPreferredFace({ boardFace: "dashboard" })).toBe("dashboard");
  });

  it("keeps different catalog threads on different destinations", () => {
    const first = sessionNavigationTarget({
      face: "chat",
      sessionKey: buildCatalogSessionKey({
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: "thread-1",
      }),
      fallbackAgentId: "main",
      mainKey: "main",
    });
    const second = sessionNavigationTarget({
      face: "chat",
      sessionKey: buildCatalogSessionKey({
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: "thread-2",
      }),
      fallbackAgentId: "main",
      mainKey: "main",
    });

    expect(first.href).toBe("/chat/main?catalog=claude&host=gateway%3Alocal&thread=thread-1");
    expect(second.href).toBe("/chat/main?catalog=claude&host=gateway%3Alocal&thread=thread-2");
    expect(first.options).not.toEqual(second.options);
  });

  it("uses a catalog-owned pretty route for shareable and in-app navigation", () => {
    const target = sessionNavigationTarget({
      face: "chat",
      sessionKey: buildCatalogSessionKey({
        catalogId: "beam",
        hostId: "gateway",
        threadId: "0123456789abcdef0123456789abcdef",
      }),
      fallbackAgentId: "main",
      basePath: "/openclaw",
      catalogShareRoute: { routeSegment: "beam", hostId: "gateway" },
    });

    expect(target).toEqual({
      href: "/openclaw/beam/0123456789ab",
      options: { pathname: "/openclaw/beam/0123456789ab" },
    });
  });

  it("requires the destination face while preserving catalog identity", () => {
    const catalogKey = {
      catalogId: "claude",
      hostId: "gateway:local",
      threadId: "thread-1",
    };
    const target = sessionNavigationTarget({
      face: "dashboard",
      sessionKey: buildCatalogSessionKey(catalogKey, "research"),
      fallbackAgentId: "main",
      basePath: "/admin/openclaw/",
      mainKey: "workspace",
    });

    const canonicalHref = buildControlUiCatalogSessionUrl({
      namespace: "dashboard",
      agentId: "research",
      basePath: "/admin/openclaw/",
      catalog: catalogKey.catalogId,
      host: catalogKey.hostId,
      thread: catalogKey.threadId,
    });
    expect(canonicalHref).not.toBeNull();
    expect(target.href).toBe(canonicalHref);
    expect(target).toEqual({
      href: "/admin/openclaw/dashboard/research?catalog=claude&host=gateway%3Alocal&thread=thread-1",
      options: {
        pathname: "/admin/openclaw/dashboard/research",
        search: "?catalog=claude&host=gateway%3Alocal&thread=thread-1",
      },
    });
  });

  it("keeps ordinary literal session paths unchanged", () => {
    expect(
      sessionNavigationTarget({
        face: "chat",
        sessionKey: "telegram:12345",
        fallbackAgentId: "research",
      }),
    ).toEqual({
      href: "/chat/research/telegram/12345",
      options: { pathname: "/chat/research/telegram/12345" },
    });
  });

  it("marks an uncached preference-derived face for in-app navigation but keeps href shareable", () => {
    const target = sessionNavigationTarget({
      face: "chat",
      sessionKey: "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
      fallbackAgentId: "main",
      preferenceDerivedFace: true,
    });

    // href gets copied and shared, so it stays the clean best-guess path; only the
    // in-app navigation carries the marker that lets the loader re-derive the face.
    expect(target.href).toBe("/chat/main/12345678");
    expect(target.options).toEqual({
      pathname: "/chat/main/12345678",
      search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
    });
  });

  it("leaves a cached row unmarked because its stored face is already authoritative", () => {
    const row = {
      key: "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
      displayName: "Release Notes",
    };
    const target = sessionNavigationTarget({
      face: "chat",
      sessionKey: row.key,
      fallbackAgentId: "main",
      row,
      preferenceDerivedFace: true,
    });

    expect(target.href).toBe("/chat/main/release-notes-12345678");
    expect(target.options).toEqual({
      pathname: "/chat/main/release-notes-12345678",
      search: `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(row.key)}`,
    });
  });

  it("treats another agent's cached global row as uncached", () => {
    const context = {
      basePath: "",
      gateway: { snapshot: { hello: null } },
      agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
      agentSelection: { state: { selectedId: "research" } },
      sessions: {
        state: {
          agentId: "main",
          result: {
            sessions: [{ key: "global", boardFace: "dashboard" }],
          },
        },
      },
    } as unknown as ApplicationContext;

    const face = resolveSessionPreferredFaceForKey(context, "global");
    const target = sessionNavigationTarget({
      context,
      face,
      sessionKey: "global",
      agentId: "research",
      preferenceDerivedFace: true,
    });

    expect(face).toBe("chat");
    expect(target.options).toEqual({
      pathname: "/chat/research",
      search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
    });
  });
});
