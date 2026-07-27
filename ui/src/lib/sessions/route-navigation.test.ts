import { describe, expect, it } from "vitest";
import { buildCatalogSessionKey } from "./catalog-key.ts";
import { resolveSessionPreferredFace, sessionNavigationTarget } from "./route-navigation.ts";

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

  it("requires the destination face while preserving catalog identity", () => {
    const target = sessionNavigationTarget({
      face: "dashboard",
      sessionKey: buildCatalogSessionKey({
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: "thread-1",
      }),
      fallbackAgentId: "research",
      mainKey: "workspace",
    });

    expect(target).toEqual({
      href: "/dashboard/research?catalog=claude&host=gateway%3Alocal&thread=thread-1",
      options: {
        pathname: "/dashboard/research",
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
});
