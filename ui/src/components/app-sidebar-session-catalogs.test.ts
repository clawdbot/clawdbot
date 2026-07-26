import { describe, expect, it } from "vitest";
import { catalogSessionNavigation } from "./app-sidebar-session-catalog-navigation.ts";

describe("catalog session navigation", () => {
  it("keeps different catalog threads on different destinations", () => {
    const first = catalogSessionNavigation(
      "main",
      {
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: "thread-1",
      },
      "",
      "main",
    );
    const second = catalogSessionNavigation(
      "main",
      {
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: "thread-2",
      },
      "",
      "main",
    );

    expect(first.href).toBe("/chat/main?catalog=claude&host=gateway%3Alocal&thread=thread-1");
    expect(second.href).toBe("/chat/main?catalog=claude&host=gateway%3Alocal&thread=thread-2");
    expect(first.navigation).not.toEqual(second.navigation);
  });

  it("uses the configured main key while keeping the agent-only catalog path", () => {
    const target = catalogSessionNavigation(
      "research",
      { catalogId: "claude", hostId: "gateway:local", threadId: "thread-1" },
      "",
      "workspace",
    );

    expect(target.href).toBe("/chat/research?catalog=claude&host=gateway%3Alocal&thread=thread-1");
  });
});
